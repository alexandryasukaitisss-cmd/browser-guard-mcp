const assert = require('node:assert/strict');
const test = require('node:test');

// Capture a process-level guard before runtime binds execFile. No test may open a real dialog.
const childProcess = require('node:child_process');
const originalExecFile = childProcess.execFile;
childProcess.execFile = () => { throw new Error('real child process forbidden in runtime unit tests'); };
const { RouterError, buildChromeArgs, minimalChildEnv, normalizeConfig } = require('../src/runtime.cjs');
childProcess.execFile = originalExecFile;

test('runtime config requires an explicit Playwright entrypoint and keeps the isolated profile flags', () => {
  const config = normalizeConfig({
    runtimeDir: '/tmp/router-runtime',
    chrome: { playwrightCli: '/tmp/playwright-mcp.js' },
  });
  assert.equal(config.chrome.nodeCommand, process.execPath);
  const args = buildChromeArgs(config.chrome, 'http://127.0.0.1:9000', '/tmp/private-chrome-output');
  assert.deepEqual(args.slice(0, 12), [
    '/tmp/playwright-mcp.js', '--browser', 'chrome', '--headless', '--isolated', '--block-service-workers',
    '--output-mode', 'stdout', '--image-responses', 'omit', '--output-dir', '/tmp/private-chrome-output',
  ]);
  assert.ok(args.includes('--proxy-server'));
  assert.ok(args.includes('<-loopback>'));
});

test('runtime refuses flags that weaken persistence or network boundaries', () => {
  assert.throws(
    () => normalizeConfig({ runtimeDir: '/tmp/router-runtime', chrome: { playwrightCli: 'playwright', extraArgs: ['--no-sandbox'] } }),
    (error) => error instanceof RouterError && error.code === 'INVALID_CONFIG',
  );
  assert.throws(
    () => normalizeConfig({ runtimeDir: '/tmp/router-runtime', chrome: { playwrightCli: 'playwright', extraArgs: ['--proxy-server=http://outside.example'] } }),
    (error) => error instanceof RouterError && error.code === 'INVALID_CONFIG',
  );
});

test('runtime passes browser children a minimal environment without ambient credentials or proxy overrides', () => {
  const environment = minimalChildEnv({ PATH: '/bin', HOME: '/tmp/home', HTTP_PROXY: 'http://attacker', AWS_SECRET_ACCESS_KEY: 'secret', LANG: 'en_US.UTF-8' });
  assert.deepEqual(environment, { PATH: '/bin', HOME: '/tmp/home', LANG: 'en_US.UTF-8' });
});

test('native one-use dialog is a six-line card with two safe choices', async () => {
  const { createMacosApprovalPrompt } = require('../src/runtime.cjs');
  const calls = [];
  const prompt = createMacosApprovalPrompt({ runAppleScript: async (...args) => { calls.push(args); return { stdout: 'button returned:Allow once\n' }; } });
  assert.equal(await prompt({ origin: 'https://example.com:443', tool: 'browser_click' }), 'once');
  const [command, args, options] = calls[0];
  assert.equal(command, '/usr/bin/osascript');
  assert.match(args[1], /buttons \{"Deny", "Allow once"\}/);
  assert.match(args[1], /default button "Deny" cancel button "Deny"/);
  const message = JSON.parse(/^display dialog ("(?:[^"\\]|\\.)*") with title/.exec(args[1])[1]);
  assert.equal(message.split('\n').length, 6);
  assert.match(message, /https:\/\/example.com/);
  assert.match(message, /card data, a password, or a one-time code/);
  assert.equal(options.timeout, 60_000);
});

test('native dialog maps only exact button responses and fails closed on timeout', async () => {
  const { createMacosApprovalPrompt } = require('../src/runtime.cjs');
  for (const [stdout, expected] of [
    ['button returned:Allow once', 'once'], ['button returned:Deny', false],
    ['the user agrees', false], ['prefix button returned:Allow for 10 minutes', false],
  ]) {
    assert.equal(await createMacosApprovalPrompt({ runAppleScript: async () => ({ stdout }) })({ origin: 'https://example.com', tool: 'browser_click' }), expected);
  }
  assert.equal(await createMacosApprovalPrompt({ runAppleScript: async () => { throw new Error('timeout'); } })({ origin: 'https://example.com', tool: 'browser_click' }), false);
});
