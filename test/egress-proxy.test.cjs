// @covers workspace-sdd:DEL-010
const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { PassThrough } = require('node:stream');

const { bridgeTunnel, parseConnectTarget, startPublicEgressProxy } = require('../src/egress-proxy.cjs');

test('CONNECT parser rejects malformed and non-web destinations', () => {
  assert.deepEqual(parseConnectTarget('example.com:443'), { hostname: 'example.com', port: 443 });
  assert.deepEqual(parseConnectTarget('[2001:db8::1]:443'), { hostname: '2001:db8::1', port: 443 });
  assert.throws(() => parseConnectTarget('example.com'), /NETWORK_DENIED/);
});

test('CONNECT tunnel absorbs either peer closing with an error', () => {
  const client = new PassThrough();
  const upstream = new PassThrough();
  bridgeTunnel(client, upstream, Buffer.alloc(0));

  assert.doesNotThrow(() => client.emit('error', new Error('write EPIPE')));
  assert.equal(upstream.destroyed, true);
});

test('egress proxy blocks private DNS targets before opening a socket', async () => {
  const proxy = await startPublicEgressProxy({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(new URL(proxy.url).port, '127.0.0.1');
    let output = '';
    socket.on('connect', () => socket.write('CONNECT private.example:443 HTTP/1.1\r\nHost: private.example:443\r\n\r\n'));
    socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolve(output));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
  await proxy.close();
});

test('egress proxy rejects a capability-disallowed redirect before DNS resolution', async () => {
  let lookups = 0;
  const proxy = await startPublicEgressProxy({
    lookup: async () => { lookups += 1; return [{ address: '127.0.0.1', family: 4 }]; },
    isHostAllowed: (host) => host === 'docs.example.com',
  });
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(new URL(proxy.url).port, '127.0.0.1');
    let output = '';
    socket.on('connect', () => socket.write('CONNECT redirect.example:443 HTTP/1.1\r\nHost: redirect.example:443\r\n\r\n'));
    socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolve(output));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(lookups, 0);
  await proxy.close();
});

test('proxy shutdown tears down an open client connection', async () => {
  const proxy = await startPublicEgressProxy();
  const socket = net.connect(new URL(proxy.url).port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await Promise.race([
    Promise.all([proxy.close(), closed]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('proxy close timed out')), 500)),
  ]);
  assert.equal(socket.destroyed, true);
});
