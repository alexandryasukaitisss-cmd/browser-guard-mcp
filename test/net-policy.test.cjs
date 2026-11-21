// @covers workspace-sdd:DEL-010
const assert = require('node:assert/strict');
const test = require('node:test');

const { RouterError, assertPublicUrl, isPublicAddress, resolvePublicAddress } = require('../src/net-policy.cjs');

test('private, loopback, special-use, and multicast addresses are never public', () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '172.16.0.1',
    '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946'), true);
});

test('router navigation only accepts public HTTP(S) URLs on standard web ports', () => {
  assert.equal(assertPublicUrl('https://example.com/path?x=1').hostname, 'example.com');
  for (const url of [
    'file:///etc/passwd', 'data:text/html,hello', 'http://localhost', 'http://127.0.0.1',
    'http://[::1]', 'https://example.com:8443', 'https://user:pass@example.com',
  ]) {
    assert.throws(() => assertPublicUrl(url), (error) => error instanceof RouterError && error.code === 'NETWORK_DENIED');
  }
});

test('hostname resolution connects to a concrete public address and fails closed without one', async () => {
  const address = await resolvePublicAddress('mixed.example', async () => [
    { address: '127.0.0.1', family: 4 },
    { address: '93.184.216.34', family: 4 },
  ]);
  assert.deepEqual(address, { address: '93.184.216.34', family: 4 });
  await assert.rejects(
    () => resolvePublicAddress('private.example', async () => [{ address: '10.0.0.1', family: 4 }]),
    (error) => error instanceof RouterError && error.code === 'NETWORK_DENIED',
  );
});
