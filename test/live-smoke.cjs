#!/usr/bin/env node
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { resolve } = require('node:path');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function startClient(configPath) {
  const child = spawn(process.execPath, [resolve(__dirname, '../src/cli.cjs'), '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    request.resolve(message);
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 90_000);
    pending.set(id, { resolve: resolveRequest, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const stop = async () => {
    for (const item of pending.values()) item.reject(new Error('router stopped'));
    child.kill('SIGTERM');
    await new Promise((resolveStop) => child.once('exit', resolveStop));
  };
  return { request, stop };
}

function toolText(response) {
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text || 'tool call failed');
  return response.result.content?.find((item) => item.type === 'text')?.text || '';
}

async function main() {
  const configPath = argValue('--config', process.env.BROWSER_GUARD_MCP_CONFIG);
  if (!configPath) throw new Error('--config or BROWSER_GUARD_MCP_CONFIG is required');
  const publicUrl = argValue('--public-url', 'https://example.com/');
  const client = startClient(configPath);
  try {
    const initialized = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'router-smoke', version: '1' } });
    if (initialized.result?.serverInfo?.name !== 'browser-guard-mcp') throw new Error('MCP initialize failed');
    const tools = await client.request('tools/list', {});
    const names = new Set(tools.result?.tools?.map((tool) => tool.name));
    for (const required of ['browser_route_open', 'browser_route_call', 'browser_evidence_bundle', 'browser_compatibility_summary']) {
      if (!names.has(required)) throw new Error(`missing tool: ${required}`);
    }
    if (names.has('browser_navigate')) throw new Error('raw browser tools must not be exposed');

    const opened = JSON.parse(toolText(await client.request('tools/call', { name: 'browser_route_open', arguments: { url: publicUrl, intent: 'read' } })));
    if (opened.backend !== 'chrome') throw new Error(`read route used ${opened.backend}`);
    const evidence = JSON.parse(toolText(await client.request('tools/call', { name: 'browser_evidence_bundle', arguments: {} })));
    if (!evidence.bundle_id || evidence.backend !== 'chrome') throw new Error('in-memory evidence failed');
    toolText(await client.request('tools/call', { name: 'browser_route_call', arguments: { tool: 'browser_snapshot', arguments: {} } }));

    const denied = await client.request('tools/call', { name: 'browser_route_open', arguments: { url: 'http://127.0.0.1/', intent: 'read' } });
    if (!denied.result?.isError) throw new Error('private route was not denied');
    const summary = JSON.parse(toolText(await client.request('tools/call', { name: 'browser_compatibility_summary', arguments: {} })));
    if (summary.success < 2 || summary.failure < 1) throw new Error('ledger did not record expected aggregate outcomes');
    process.stdout.write(`${JSON.stringify({ ok: true, routed_read: opened.backend, evidence: 'memory', private_network: 'blocked', ledger_entries: summary.entries })}\n`);
  } finally {
    await client.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
