// @covers workspace-sdd:DEL-010
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { EvidenceStore } = require('../src/evidence.cjs');
const { CompatibilityLedger } = require('../src/ledger.cjs');

test('evidence is bounded in memory and never creates a runtime artifact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-guard-mcp-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new EvidenceStore({ maxBundles: 2, maxTextChars: 12, now: () => '2026-08-09T00:00:00.000Z' });
  const first = store.capture({ backend: 'chrome', url: 'https://example.com', markdown: '0123456789abcdef', links: [{ text: 'a', href: 'https://example.com/a' }] });
  store.capture({ backend: 'chrome', url: 'https://example.com/2', markdown: 'second' });
  store.capture({ backend: 'chrome', url: 'https://example.com/3', markdown: 'third' });

  assert.equal(first.markdown, '0123456789ab');
  assert.equal(store.get(first.bundle_id), undefined);
  assert.equal((await readdir(dir)).length, 0);
});

test('evidence expires at its configured lifetime instead of surviving the browser grant', () => {
  let now = 0;
  const evidence = new EvidenceStore({ now: () => new Date(now).toISOString(), ttlMs: 1_000 });
  const bundle = evidence.capture({ backend: 'chrome', url: 'https://example.com', markdown: 'private page' });
  now = 1_001;
  assert.equal(evidence.get(bundle.bundle_id), undefined);
});

test('ledger keeps only redacted, bounded machine-local diagnostics', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-guard-mcp-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new CompatibilityLedger({ dir, maxEntries: 2, now: () => '2026-08-09T00:00:00.000Z' });
  await ledger.record({ operation: 'route_open', backend: 'chrome', intent: 'read', outcome: 'failure', category: 'backend_unavailable', url: 'https://secret.example/a', raw_error: 'token=super-secret' });
  await ledger.record({ operation: 'route_open', backend: 'chrome', intent: 'visual', outcome: 'success', title: 'private title' });
  await ledger.record({ operation: 'route_call', backend: 'chrome', outcome: 'failure', category: 'tool_error', capability: 'interact', duration: 'under_1m', profile_id: 'private-profile', confirmation_id: 'secret-confirmation', screenshot: 'private screenshot' });

  const payload = await readFile(join(dir, 'compatibility.jsonl'), 'utf8');
  const entries = payload.trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 2);
  assert.doesNotMatch(payload, /secret|token|title|screenshot|profile|confirmation|https?:\/\//i);
  assert.deepEqual(await ledger.summary(), { entries: 2, success: 1, failure: 1, by_backend: { chrome: 2 }, by_capability: { none: 1, interact: 1 }, by_client: { unknown: 2 } });
  assert.equal((await stat(join(dir, 'compatibility.jsonl'))).mode & 0o777, 0o600);
});

test('persisted action ledger records every interaction and only the upload file count', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-guard-mcp-scope-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new CompatibilityLedger({ dir });
  for (const operation of ['interaction_action', 'file_upload', 'interaction_action']) {
    await ledger.record({ operation, backend: 'chrome', intent: 'interactive', outcome: 'success', category: 'none', capability: 'interact', duration: '5m_to_15m', arguments: { text: 'secret-input' }, origin: 'https://private.example', file_count: 2, paths: ['/private/file'] });
  }
  const body = await readFile(ledger.path, 'utf8');
  assert.deepEqual((await ledger.records()).map((entry) => entry.operation), ['interaction_action', 'file_upload', 'interaction_action']);
  assert.doesNotMatch(body, /secret-input|private|arguments|origin|paths/);
  assert.equal((await ledger.records())[1].file_count, 2);
});
