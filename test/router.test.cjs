const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BrowserGuard } = require('../src/router.cjs');
const { CapabilityPolicy } = require('../src/capability-policy.cjs');

const SNAPSHOT = `### Page
- Page URL: https://example.com/
### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - heading "Example" [level=1] [ref=e2]
  - link "More information" [ref=e3]
  - textbox "Search" [ref=e4]
  - textbox "Password" [ref=e9]
\`\`\``;

class FakeChrome {
  constructor({ cwd, snapshot = SNAPSHOT, toolError, url = 'https://example.com/' } = {}) {
    this.cwd = cwd;
    this.snapshot = snapshot;
    this.url = url;
    this.toolError = toolError;
    this.calls = [];
    this.tools = [
      'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form',
      'browser_press_key', 'browser_select_option', 'browser_hover', 'browser_file_upload',
      'browser_console_messages', 'browser_wait_for', 'browser_close',
    ].map((name) => ({ name, inputSchema: { type: 'object' } }));
  }

  async start() {}
  async listTools() { return this.tools; }

  async callTool(name, args) {
    this.calls.push({ name, args });
    if (this.toolError === name) return { content: [{ type: 'text', text: 'backend failure' }], isError: true };
    if (name === 'browser_snapshot') return { content: [{ type: 'text', text: this.snapshot.replace('https://example.com/', this.url) }] };
    if (name === 'browser_console_messages') return { content: [{ type: 'text', text: JSON.stringify([]) }] };
    return { content: [{ type: 'text', text: JSON.stringify({ name, args }) }] };
  }

  async stop() {}

  setUrl(url) { this.url = url; }
}

function memoryLedger(events = []) {
  return { record: async (event) => events.push(event), summary: async () => ({ entries: events.length, success: events.filter((e) => e.outcome === 'success').length, failure: events.filter((e) => e.outcome === 'failure').length, by_backend: {} }) };
}

function policy({ approval = async () => 'once', defaultProfile = 'public-interact' } = {}) {
  const prompts = [];
  const capabilities = new CapabilityPolicy({
    approvalPrompt: async (request) => { prompts.push(request); return approval(request); },
    config: { defaultProfile, profiles: [
      { id: 'public-read', hosts: ['*'], operations: ['navigate', 'read', 'extract', 'observe'], maxTtlSeconds: 900 },
      { id: 'public-interact', hosts: ['*'], operations: ['navigate', 'read', 'extract', 'observe', 'interact'], maxTtlSeconds: 900 },
    ] },
  });
  return { capabilities, prompts };
}

function create({ chrome = new FakeChrome(), ledger = memoryLedger(), capabilities } = {}) {
  const router = new BrowserGuard({ chromeFactory: async () => chrome, ledger, ...(capabilities ? { capabilities } : {}) });
  return { router, chrome, ledger };
}

test('router exposes only the capability-scoped surface, not raw browser tools', async () => {
  const { router } = create();
  const names = (await router.listTools()).map((tool) => tool.name);
  assert.ok(names.includes('browser_route_open'));
  assert.ok(names.includes('browser_action_prepare'));
  assert.ok(!names.includes('browser_navigate'));
  await assert.rejects(() => router.callTool('browser_navigate', { url: 'https://example.com' }), /TOOL_DENIED/);
  await assert.rejects(() => router.callTool('browser_evaluate', { function: '() => 1' }), /TOOL_DENIED/);
});

test('routed open uses the isolated browser and blocks private targets before dispatch', async () => {
  const events = [];
  const chrome = new FakeChrome();
  const { router } = create({ chrome, ledger: memoryLedger(events) });
  const opened = JSON.parse((await router.callTool('browser_route_open', { url: 'https://example.com/', intent: 'read' })).content[0].text);
  assert.equal(opened.backend, 'chrome');
  assert.equal(chrome.calls[0].name, 'browser_navigate');

  await assert.rejects(
    () => router.callTool('browser_route_open', { url: 'http://127.0.0.1/', intent: 'read' }),
    (error) => error.code === 'NETWORK_DENIED',
  );
  assert.equal(chrome.calls.length, 1);
  assert.deepEqual(events.at(-1), { operation: 'route_open', backend: 'none', intent: 'read', outcome: 'failure', category: 'policy_denied', client: 'unknown' });
});

test('ordinary interaction dispatches without a dialog; sensitive input needs one exact one-use approval', async () => {
  const { capabilities, prompts } = policy();
  const chrome = new FakeChrome();
  const { router } = create({ chrome, capabilities });
  await router.callTool('browser_route_open', { url: 'https://example.com/', intent: 'interactive' });

  await router.callTool('browser_route_call', { tool: 'browser_click', arguments: { element: 'More information', target: 'e3' } });
  assert.equal(prompts.length, 0);

  const typed = { element: 'Password', target: 'e9', text: 'not-logged' };
  await assert.rejects(
    () => router.callTool('browser_route_call', { tool: 'browser_type', arguments: typed }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
  assert.equal(chrome.calls.filter((call) => call.name === 'browser_type').length, 0);
  assert.equal(prompts.length, 0);

  const prepared = JSON.parse((await router.callTool('browser_action_prepare', { tool: 'browser_type', arguments: typed })).content[0].text);
  assert.equal(prompts.length, 1);
  await router.callTool('browser_route_call', { tool: 'browser_type', arguments: typed, confirmation_id: prepared.confirmation_id });
  assert.equal(chrome.calls.filter((call) => call.name === 'browser_type').length, 1);

  await assert.rejects(
    () => router.callTool('browser_route_call', { tool: 'browser_type', arguments: typed, confirmation_id: prepared.confirmation_id }),
    (error) => error.code === 'CONFIRMATION_DENIED',
  );
});

test('a profile without interact cannot click, and activation applies to the open page', async () => {
  const { capabilities } = policy({ defaultProfile: 'public-read' });
  const { router } = create({ capabilities });
  await router.callTool('browser_route_open', { url: 'https://example.com/' });
  await assert.rejects(
    () => router.callTool('browser_route_call', { tool: 'browser_click', arguments: { target: 'e3' } }),
    (error) => error.code === 'CAPABILITY_DENIED',
  );
  await router.callTool('browser_capability_activate', { profile_id: 'public-interact' });
  await router.callTool('browser_route_call', { tool: 'browser_click', arguments: { target: 'e3' } });
});

test('route_call re-checks navigation and cannot be used to reach a private address', async () => {
  const chrome = new FakeChrome();
  const { router } = create({ chrome });
  await router.callTool('browser_route_open', { url: 'https://example.com/', intent: 'interactive' });
  await assert.rejects(
    () => router.callTool('browser_route_call', { tool: 'browser_navigate', arguments: { url: 'http://localhost/' } }),
    (error) => error.code === 'NETWORK_DENIED',
  );
  assert.equal(chrome.calls.length, 1);
});

test('evidence is captured in memory from the active page and is bounded by the grant', async () => {
  const { router } = create();
  await router.callTool('browser_route_open', { url: 'https://example.com/' });
  const bundle = JSON.parse((await router.callTool('browser_evidence_bundle', {})).content[0].text);
  assert.equal(bundle.backend, 'chrome');
  assert.equal(bundle.url, 'https://example.com/');
  assert.match(bundle.snapshot, /Password/);
  assert.equal(typeof bundle.content_hash, 'string');
  const cached = JSON.parse((await router.callTool('browser_evidence_get', { bundle_id: bundle.bundle_id })).content[0].text);
  assert.equal(cached.bundle_id, bundle.bundle_id);
});

test('a backend tool error is never reported as a successful route', async () => {
  const chrome = new FakeChrome({ toolError: 'browser_navigate' });
  const { router } = create({ chrome });
  await assert.rejects(
    () => router.callTool('browser_route_open', { url: 'https://example.com/' }),
    (error) => error.code === 'TOOL_ERROR',
  );
});

test('upload validates every path and records only the file count', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ordinary = path.join(dir, 'ordinary.txt');
  const secret = path.join(dir, '.env.local');
  fs.writeFileSync(ordinary, 'ordinary');
  fs.writeFileSync(secret, 'synthetic fixture');
  const chrome = new FakeChrome({ cwd: dir });
  const events = [];
  const { capabilities } = policy();
  const { router } = create({ chrome, ledger: memoryLedger(events), capabilities });
  await router.callTool('browser_route_open', { url: 'https://example.com/', intent: 'interactive' });

  await router.callTool('browser_route_call', { tool: 'browser_file_upload', arguments: { paths: [ordinary] } });
  assert.equal(events.at(-1).operation, 'file_upload');
  assert.equal(events.at(-1).file_count, 1);
  await assert.rejects(
    () => router.callTool('browser_route_call', { tool: 'browser_file_upload', arguments: { paths: [ordinary, secret] } }),
    (error) => error.code === 'UPLOAD_SECRET_DENIED',
  );
  assert.equal(events.at(-1).file_count, 2);
  assert.doesNotMatch(JSON.stringify(events), /ordinary|env|paths|synthetic/);
});

test('status reports the active backend and capability without page data', async () => {
  const { capabilities } = policy();
  const { router } = create({ capabilities });
  await router.callTool('browser_route_open', { url: 'https://example.com/' });
  const status = JSON.parse((await router.callTool('browser_guard_status', {})).content[0].text);
  assert.equal(status.active_backend, 'chrome');
  assert.equal(status.chrome, 'available');
  assert.equal(status.capabilities.profile_id, 'public-interact');
  assert.doesNotMatch(JSON.stringify(status), /example\.com|Password/);
});


test('route_call navigation refreshes the active URL from the new snapshot', async () => {
  const chrome = new FakeChrome();
  const { router } = create({ chrome });
  await router.callTool('browser_route_open', { url: 'https://example.com/', intent: 'interactive' });
  chrome.setUrl('https://example.org/');
  await router.callTool('browser_route_call', { tool: 'browser_navigate', arguments: { url: 'https://example.org/' } });
  const bundle = JSON.parse((await router.callTool('browser_evidence_bundle', {})).content[0].text);
  assert.equal(bundle.url, 'https://example.org/');
  chrome.setUrl('https://example.com/');
  await router.callTool('browser_route_call', { tool: 'browser_navigate_back', arguments: {} });
  const back = JSON.parse((await router.callTool('browser_evidence_bundle', {})).content[0].text);
  assert.equal(back.url, 'https://example.com/');
});

test('a backend without browser_navigate fails closed before any open', async () => {
  const chrome = new FakeChrome();
  chrome.tools = chrome.tools.filter((tool) => tool.name !== 'browser_navigate');
  const { router } = create({ chrome });
  await assert.rejects(
    () => router.callTool('browser_route_open', { url: 'https://example.com/' }),
    (error) => error.code === 'TOOL_DENIED',
  );
});

test('unknown backend and calls after close fail without page data', async () => {
  const { router } = create();
  await assert.rejects(
    () => router.callTool('browser_route_call', { backend: 'other', tool: 'browser_snapshot', arguments: {} }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  await router.callTool('browser_route_open', { url: 'https://example.com/', intent: 'interactive' });
  await router.callTool('browser_route_call', { tool: 'browser_close', arguments: {} });
  await assert.rejects(
    () => router.callTool('browser_route_call', { tool: 'browser_snapshot', arguments: {} }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});
