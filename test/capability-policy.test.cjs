const assert = require('node:assert/strict');
const test = require('node:test');

const { CapabilityPolicy, hostMatches, normalizeCapabilityConfig } = require('../src/capability-policy.cjs');

test('capability profiles enforce DNS host boundaries and bounded lifetimes', () => {
  let now = 0;
  const policy = new CapabilityPolicy({
    now: () => now,
    config: { defaultProfile: 'docs', profiles: [{ id: 'docs', hosts: ['docs.example.com', '*.reference.example'], operations: ['navigate', 'read'], maxTtlSeconds: 120 }] },
  });
  assert.equal(hostMatches('*.reference.example', 'api.reference.example'), true);
  assert.equal(hostMatches('*.reference.example', 'reference.example'), false);
  assert.equal(hostMatches('*.reference.example', 'notreference.example'), false);
  assert.doesNotThrow(() => policy.authorize({ url: new URL('https://docs.example.com/guide'), operation: 'navigate' }));
  assert.throws(() => policy.authorize({ url: new URL('https://notdocs.example.com/'), operation: 'navigate' }), /CAPABILITY_DENIED/);
  now = 120_001;
  assert.throws(() => policy.authorize({ url: new URL('https://docs.example.com/guide'), operation: 'navigate' }), /CAPABILITY_DENIED/);
});

test('interactive confirmation is one-use and bound to grant, host, tool, and arguments', async () => {
  let now = 0;
  const policy = new CapabilityPolicy({
    now: () => now,
    approvalPrompt: async () => true,
    config: { defaultProfile: 'write', confirmationTtlSeconds: 15, profiles: [{ id: 'write', hosts: ['example.com'], operations: ['navigate', 'interact'], maxTtlSeconds: 120 }] },
  });
  const grantId = policy.activeGrantId;
  assert.throws(
    () => policy.authorizeTool({ grantId, url: 'https://example.com', tool: 'browser_fill', arguments: { selector: '#password', type: 'password', value: 'secret' } }),
    /CONFIRMATION_REQUIRED/,
  );
  const confirmation = await policy.prepareInteraction({ grantId, url: 'https://example.com', tool: 'browser_click', arguments: { selector: '#publish' } });
  assert.throws(
    () => policy.authorizeTool({ grantId, url: 'https://example.com', tool: 'browser_click', arguments: { selector: '#different' }, confirmationId: confirmation.id }),
    /CONFIRMATION_DENIED/,
  );
  assert.throws(
    () => policy.authorizeTool({ grantId, url: 'https://example.com', tool: 'browser_click', arguments: { selector: '#publish' }, confirmationId: confirmation.id }),
    /CONFIRMATION_DENIED/,
  );
  const next = await policy.prepareInteraction({ grantId, url: 'https://example.com', tool: 'browser_click', arguments: { selector: '#publish' } });
  assert.doesNotThrow(() => policy.authorizeTool({ grantId, url: 'https://example.com', tool: 'browser_click', arguments: { selector: '#publish' }, confirmationId: next.id }));
  assert.throws(
    () => policy.authorizeTool({ grantId, url: 'https://example.com', tool: 'browser_evaluate_future', arguments: {} }),
    /TOOL_DENIED/,
  );
});

test('capability configuration rejects ambiguous or unbounded profile definitions', () => {
  assert.throws(
    () => normalizeCapabilityConfig({ defaultProfile: 'bad', profiles: [{ id: 'bad', hosts: ['*example.com'], operations: ['navigate'], maxTtlSeconds: 30 }] }),
    /INVALID_CONFIG/,
  );
  assert.throws(
    () => normalizeCapabilityConfig({ defaultProfile: 'missing', profiles: [{ id: 'present', hosts: ['example.com'], operations: ['navigate'], maxTtlSeconds: 60 }] }),
    /INVALID_CONFIG/,
  );
});

test('legacy once confirmations reject expiry and exact-origin changes without a scope', async () => {
  let now = 0;
  const policy = new CapabilityPolicy({ now: () => now, approvalPrompt: async () => true,
    config: { defaultProfile: 'write', confirmationTtlSeconds: 15, profiles: [{ id: 'write', hosts: ['*'], operations: ['interact'], maxTtlSeconds: 120 }] },
  });
  const request = { url: 'https://example.com', tool: 'browser_click', arguments: { selector: '#save' } };
  for (const url of ['http://example.com', 'https://example.com:8443', 'https://sub.example.com']) {
    const prepared = await policy.prepareInteraction(request);
    assert.throws(() => policy.authorizeTool({ ...request, url, confirmationId: prepared.id }), /CONFIRMATION_DENIED/);
  }
  const prepared = await policy.prepareInteraction(request);
  now = 15_000;
  assert.throws(() => policy.authorizeTool({ ...request, confirmationId: prepared.id }), /CONFIRMATION_DENIED/);
});

test('existing public-read profile can still scroll without native approval', () => {
  const policy = new CapabilityPolicy();
  assert.equal(policy.authorizeTool({ url: 'https://example.com', tool: 'browser_scroll', arguments: { direction: 'down' } }).operation, 'observe');
});
