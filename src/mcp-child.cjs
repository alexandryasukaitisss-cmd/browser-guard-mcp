const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { RouterError } = require('./route-policy.cjs');

function defaultChildEnv(source = process.env) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_CTYPE', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return Object.fromEntries(allowed.flatMap((key) => typeof source[key] === 'string' ? [[key, source[key]]] : []));
}

class McpChildClient {
  constructor({ name, command, args = [], env = defaultChildEnv(), cwd, timeoutMs = 20_000, spawnProcess = spawn }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.sequence = 0;
    this.pending = new Map();
    this.tools = null;
    this.child = null;
  }

  async start() {
    if (this.child) return this;
    try {
      this.child = this.spawnProcess(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      throw new RouterError('BACKEND_UNAVAILABLE', `${this.name} could not start`);
    }
    this.child.once('error', () => this.rejectAll());
    this.child.once('exit', () => this.rejectAll());
    // A child that dies mid-write must reject pending calls, not crash the router with EPIPE.
    this.child.stdin?.on('error', () => this.rejectAll());
    this.child.stderr?.resume();
    const output = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    output.on('line', (line) => this.onMessage(line));
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'browser-guard-mcp', version: require('../package.json').version } });
    this.notify('notifications/initialized', {});
    return this;
  }

  onMessage(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new RouterError('BACKEND_UNAVAILABLE', `${this.name} rejected the MCP request`));
    else pending.resolve(message.result);
  }

  request(method, params) {
    if (!this.child?.stdin?.writable) return Promise.reject(new RouterError('BACKEND_UNAVAILABLE', `${this.name} is unavailable`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RouterError('BACKEND_UNAVAILABLE', `${this.name} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async listTools() {
    if (!this.tools) this.tools = (await this.request('tools/list', {})).tools || [];
    return this.tools;
  }

  callTool(name, args) { return this.request('tools/call', { name, arguments: args }); }

  rejectAll() {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new RouterError('BACKEND_UNAVAILABLE', `${this.name} stopped`));
    }
  }

  async stop() {
    this.rejectAll();
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
  }
}

module.exports = { McpChildClient, defaultChildEnv };
