// @covers workspace-sdd:DEL-010
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { McpStdioServer, classifyClient } = require('../src/server.cjs');

test('server reduces MCP client identity to a non-sensitive local audit class', () => {
  assert.equal(classifyClient({ name: 'Codex Desktop' }), 'codex');
  assert.equal(classifyClient({ name: 'OpenCode' }), 'opencode');
  assert.equal(classifyClient({ name: 'Other Agent' }), 'other');
  assert.equal(classifyClient(undefined), 'unknown');
});

test('stdio server implements the MCP initialize, tools/list, and tools/call flow', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    for (const line of chunk.trim().split('\n')) if (line) messages.push(JSON.parse(line));
  });
  const server = new McpStdioServer({
    router: { listTools: async () => [{ name: 'browser_route_open', inputSchema: { type: 'object' } }], callTool: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }] }) },
    input,
    output,
  });
  server.start();
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_route_open', arguments: { url: 'https://example.com' } } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages[0].result.serverInfo.name, 'browser-guard-mcp');
  assert.equal(messages[0].result.serverInfo.version, '0.1.0');
  assert.equal(messages[1].result.tools[0].name, 'browser_route_open');
  assert.match(messages[2].result.content[0].text, /example\.com/);
  server.stop();
});
