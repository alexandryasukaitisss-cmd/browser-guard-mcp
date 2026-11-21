const readline = require('node:readline');
const { RouterError } = require('./route-policy.cjs');

function classifyClient(clientInfo) {
  const name = String(clientInfo?.name || '').toLowerCase();
  if (name.includes('opencode')) return 'opencode';
  if (name.includes('codex')) return 'codex';
  return name ? 'other' : 'unknown';
}

class McpStdioServer {
  constructor({ router, input = process.stdin, output = process.stdout }) {
    this.router = router;
    this.input = input;
    this.output = output;
    this.reader = null;
  }

  start() {
    this.reader = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.onLine(line));
  }

  stop() { this.reader?.close(); }

  async onLine(line) {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.id === undefined) return;
    try {
      const result = await this.handle(request.method, request.params || {});
      this.write({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      if (request.method === 'tools/call') {
        const routerError = error instanceof RouterError ? error : new RouterError('INTERNAL', 'router call failed');
        this.write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: { code: routerError.code, message: routerError.message } }) }], isError: true } });
      } else {
        this.write({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error instanceof RouterError ? error.message : 'internal router error' } });
      }
    }
  }

  async handle(method, params) {
    switch (method) {
      case 'initialize':
        this.router.setClient?.(classifyClient(params.clientInfo));
        return { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'browser-guard-mcp', version: require('../package.json').version } };
      case 'ping': return {};
      case 'tools/list': return { tools: await this.router.listTools() };
      case 'tools/call': return this.router.callTool(params.name, params.arguments || {});
      default: throw new RouterError('METHOD_NOT_FOUND', `unsupported MCP method "${method}"`);
    }
  }

  write(message) { this.output.write(`${JSON.stringify(message)}\n`); }
}

module.exports = { McpStdioServer, classifyClient };
