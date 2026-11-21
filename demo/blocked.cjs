#!/usr/bin/env node
/*
 * Demonstrates the boundary without touching a private network:
 *   1. a public page opens in the isolated browser;
 *   2. the same router refuses a loopback URL before Chromium sees it;
 *   3. the local test server records zero requests.
 *
 * Requires Playwright MCP and Google Chrome. Set PLAYWRIGHT_MCP_CLI if the
 * package is not resolvable from this directory.
 */
const http = require('node:http');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRouter, loadConfig } = require('../src/runtime.cjs');

function playwrightCli() {
  if (process.env.PLAYWRIGHT_MCP_CLI) return process.env.PLAYWRIGHT_MCP_CLI;
  try { return require.resolve('@playwright/mcp/cli.js'); } catch { /* explicit env is required */ }
  throw new Error('Set PLAYWRIGHT_MCP_CLI to the absolute path of @playwright/mcp/cli.js');
}

async function main() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('local service');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dir = await mkdtemp(join(tmpdir(), 'browser-guard-mcp-demo-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    runtimeDir: join(dir, 'runtime'),
    timeoutMs: 60_000,
    chrome: { playwrightCli: playwrightCli() },
    capabilities: {
      defaultProfile: 'public-interact',
      profiles: [{ id: 'public-interact', hosts: ['*'], operations: ['navigate', 'read', 'extract', 'observe', 'interact'], maxTtlSeconds: 900 }],
    },
  }));
  const router = createRouter(await loadConfig(configPath));
  try {
    const opened = JSON.parse((await router.callTool('browser_route_open', { url: 'https://example.com/', intent: 'read' })).content[0].text);
    process.stdout.write(`public page: ${opened.url} via ${opened.backend}\n`);

    let denied;
    try {
      await router.callTool('browser_route_open', { url: `http://127.0.0.1:${port}/`, intent: 'read' });
    } catch (error) {
      denied = error.code || error.message;
    }
    if (denied !== 'NETWORK_DENIED') throw new Error(`loopback was not denied: ${denied}`);
    process.stdout.write(`loopback: ${denied}\n`);
    process.stdout.write(`local server requests: ${requests}\n`);
  } finally {
    await router.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
