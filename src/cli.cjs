#!/usr/bin/env node
const { McpStdioServer } = require('./server.cjs');
const { createRouter, loadConfig, RouterError } = require('./runtime.cjs');

function parseArgs(argv) {
  const result = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--config') result.config = argv[++index];
    else if (value === '--check') result.check = true;
    else throw new RouterError('INVALID_ARGUMENT', `unknown argument "${value}"`);
  }
  if (!result.config) throw new RouterError('INVALID_ARGUMENT', '--config is required');
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = await loadConfig(options.config);
  const router = createRouter(config);
  if (options.check) {
    const tools = await router.listTools();
    process.stdout.write(`${JSON.stringify({ ok: true, tools: tools.map((tool) => tool.name) })}\n`);
    await router.close();
    return;
  }
  const server = new McpStdioServer({ router });
  const shutdown = async () => { server.stop(); await router.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.start();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'router startup failed'}\n`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
