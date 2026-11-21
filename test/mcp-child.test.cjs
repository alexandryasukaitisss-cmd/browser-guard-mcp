// @covers workspace-sdd:DEL-010
const assert = require('node:assert/strict');
const { join } = require('node:path');
const test = require('node:test');

const { McpChildClient } = require('../src/mcp-child.cjs');

test('child MCP client performs a real stdio initialize, tool discovery, and call', async () => {
  const client = new McpChildClient({ name: 'fixture', command: process.execPath, args: [join(__dirname, 'fixtures', 'mock-mcp.cjs')] });
  await client.start();
  assert.equal((await client.listTools())[0].name, 'browser_navigate');
  const result = await client.callTool('browser_navigate', { url: 'https://example.com' });
  assert.match(result.content[0].text, /example\.com/);
  await client.stop();
});
