const readline = require('node:readline');

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'browser_navigate', inputSchema: { type: 'object' } }] }
      : request.method === 'tools/call'
        ? { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] }
        : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
