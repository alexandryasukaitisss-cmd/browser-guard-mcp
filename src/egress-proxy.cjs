const http = require('node:http');
const net = require('node:net');
const { assertPublicUrl, resolvePublicAddress, RouterError } = require('./net-policy.cjs');

function parseConnectTarget(raw) {
  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']');
    if (closing < 0 || raw[closing + 1] !== ':') throw new RouterError('NETWORK_DENIED', 'invalid proxy target');
    return { hostname: raw.slice(1, closing), port: Number(raw.slice(closing + 2)) };
  }
  const separator = raw.lastIndexOf(':');
  if (separator < 1) throw new RouterError('NETWORK_DENIED', 'invalid proxy target');
  return { hostname: raw.slice(0, separator), port: Number(raw.slice(separator + 1)) };
}

function assertWebPort(port) {
  if (![80, 443].includes(port)) throw new RouterError('NETWORK_DENIED', 'proxy only permits standard web ports');
}

function bridgeTunnel(socket, upstream, head) {
  const closeUpstream = () => { if (!upstream.destroyed) upstream.destroy(); };
  const closeSocket = () => { if (!socket.destroyed) socket.destroy(); };
  socket.once('error', closeUpstream);
  socket.once('close', closeUpstream);
  upstream.once('error', closeSocket);
  upstream.once('close', closeSocket);
  if (head?.length) upstream.write(head);
  socket.pipe(upstream);
  upstream.pipe(socket);
}

class PublicEgressProxy {
  constructor({ lookup, isHostAllowed = () => true } = {}) {
    this.lookup = lookup;
    this.isHostAllowed = isHostAllowed;
    this.connections = new Set();
    this.server = http.createServer((request, response) => this.forwardHttp(request, response));
    this.server.on('connect', (request, socket, head) => this.forwardConnect(request, socket, head));
    this.server.on('clientError', (error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    this.server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    });
  }

  async resolve(hostname) { return resolvePublicAddress(hostname, this.lookup); }

  async assertHostAllowed(hostname) {
    if (!await this.isHostAllowed(hostname)) throw new RouterError('CAPABILITY_DENIED', 'capability profile does not permit this hostname');
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  deny(socketOrResponse) {
    if (typeof socketOrResponse.writeHead === 'function') {
      socketOrResponse.writeHead(403, { Connection: 'close', 'Content-Type': 'text/plain' });
      socketOrResponse.end('blocked');
    } else socketOrResponse.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 7\r\n\r\nblocked');
  }

  async forwardConnect(request, socket, head) {
    try {
      const { hostname, port } = parseConnectTarget(request.url);
      assertWebPort(port);
      await this.assertHostAllowed(hostname);
      const target = await this.resolve(hostname);
      const upstream = net.connect({ host: target.address, port });
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        bridgeTunnel(socket, upstream, head);
      });
      upstream.once('error', () => socket.destroy());
    } catch {
      this.deny(socket);
    }
  }

  async forwardHttp(request, response) {
    try {
      const url = assertPublicUrl(request.url);
      if (url.protocol !== 'http:') throw new RouterError('NETWORK_DENIED', 'HTTPS requires CONNECT');
      const port = Number(url.port || 80);
      assertWebPort(port);
      await this.assertHostAllowed(url.hostname);
      const target = await this.resolve(url.hostname);
      const headers = { ...request.headers, host: url.host };
      delete headers['proxy-connection'];
      const upstream = http.request({ host: target.address, port, method: request.method, path: `${url.pathname}${url.search}`, headers, agent: false }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
    } catch {
      this.deny(response);
    }
  }

  async close() {
    if (!this.server.listening) return;
    for (const socket of this.connections) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

async function startPublicEgressProxy(options) {
  return new PublicEgressProxy(options).start();
}

module.exports = { PublicEgressProxy, bridgeTunnel, startPublicEgressProxy, parseConnectTarget };
