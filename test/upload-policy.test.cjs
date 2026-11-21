const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateUpload } = require('../src/upload-policy.cjs');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'router-upload-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const file = (name) => { const value = path.join(home, name); fs.mkdirSync(path.dirname(value), { recursive: true }); fs.writeFileSync(value, 'test fixture, not a secret'); return value; };
  return { dir, home, file, check: (args) => validateUpload(args, { home }) };
}

test('all named secret locations and filenames are denied after realpath', (t) => {
  const f = fixture(t);
  for (const name of ['.ssh/known_hosts', '.gnupg/data', 'Library/Keychains/login', '.aws/config', '.config/gcloud/config', '.kube/config', '.docker/config', '.config/gh/hosts.yml', '.codex/auth.json', '.claude/test.key', '.netrc', '.env', '.env.local', 'nested/.env.production', 'cert.pem', 'cert.KEY', 'cert.p12', 'cert.pfx', 'vault.kdbx', 'id_rsa', 'id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa_key', 'auth.json', 'credentials', 'credentials-prod', 'login.keychain-db']) {
    assert.throws(() => f.check({ paths: [f.file(name)] }), { code: 'UPLOAD_SECRET_DENIED' }, name);
  }
  const link = path.join(f.dir, 'ssh-link'); fs.symlinkSync(path.join(f.home, '.ssh'), link);
  assert.throws(() => f.check({ paths: [path.join(link, 'known_hosts')] }), { code: 'UPLOAD_SECRET_DENIED' });
  const renamed = path.join(f.dir, 'ordinary.txt'); fs.symlinkSync(f.file('.env.secret'), renamed);
  assert.throws(() => f.check({ paths: [renamed] }), { code: 'UPLOAD_SECRET_DENIED' });
});

test('ordinary files, example env files, aliases and safe symlinks are allowed without mutation', (t) => {
  const f = fixture(t);
  for (const name of ['ordinary.txt', 'e\u0301', '👨‍👩‍👧', ' spaced ', '\uFEFFfile', '.env.example', '.env.sample', '—', '«кавычки»', 'Łódź ąę ё', 'é', 'notes.env', 'public.json']) {
    const value = f.file(name);
    const args = { paths: [value], unrelated: 'preserved' };
    const result = f.check(args);
    assert.deepEqual(result, { arguments: { ...args, paths: [fs.realpathSync(value)] }, fileCount: 1 });
    result.arguments.paths.push('changed');
    assert.equal(args.paths.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.check(args))), f.check(args));
  }
  const link = path.join(f.dir, 'safe-link'); const file = f.file('safe'); fs.symlinkSync(file, link);
  assert.deepEqual(f.check({ paths: [link] }).arguments.paths, [file]);
  for (const key of ['files', 'file', 'filePath', 'path']) assert.equal(f.check({ [key]: key === 'files' ? [file] : file }).fileCount, 1);
  assert.equal(f.check({ paths: [] }).fileCount, 0);
});

test('missing, malformed, nonregular and mixed uploads fail before dispatch without leaking paths', (t) => {
  const f = fixture(t);
  const ordinary = f.file('ordinary');
  const secret = f.file('.env.local');
  for (const args of [undefined, null, {}, [], { paths: null }, { paths: '' }, { paths: [ordinary], files: [] }, { paths: [f.home] }, { paths: [path.join(f.home, 'missing')] }]) assert.throws(() => f.check(args), { code: 'INVALID_UPLOAD_PATH' });
  assert.throws(() => f.check({ paths: [ordinary, secret] }), (error) => error.code === 'UPLOAD_SECRET_DENIED' && !error.message.includes(secret));
  const values = [undefined, null, '', '   ', '\t\n', '\u00A0', '\u200B', '\uFEFF', '—', '«кавычки»', 'Łódź ąę ё', '👨‍👩‍👧', 'e\u0301', 'é', 'x'.repeat(4097), '\uD800', 0, -1, '1,5', '1.5', NaN, 4097];
  for (const value of values) assert.throws(() => f.check({ paths: [value] }), { code: 'INVALID_UPLOAD_PATH' });
});

test('isolated upload staging preserves filenames and cleans copies on success and failure', { timeout: 10000 }, async (t) => {
  const { withStagedUpload } = require('../src/upload-policy.cjs');
  const f = fixture(t);
  const source = f.file('ordinary.txt');
  const cwd = path.join(f.dir, 'backend'); fs.mkdirSync(cwd);
  for (const fail of [false, true]) {
    const cleanup = [];
    let selectedPaths;
    const run = () => withStagedUpload(f.check({ paths: [source, source] }).arguments, cwd, async (args) => {
      selectedPaths = args.paths;
      assert.equal(args.paths.length, 2);
      assert.notEqual(args.paths[0], args.paths[1]);
      for (const value of args.paths) {
        assert.equal(path.basename(value), 'ordinary.txt');
        assert.equal(fs.readFileSync(value, 'utf8'), 'test fixture, not a secret');
        assert.equal(fs.statSync(value).mode & 0o777, 0o600);
      }
      if (fail) throw Error('backend failure');
      return 'uploaded';
    }, (hook) => cleanup.push(hook));
    if (fail) await assert.rejects(run, /backend failure/); else assert.equal(await run(), 'uploaded');
    if (!fail) {
      assert.equal(fs.readdirSync(cwd).length, 1);
      for (const selected of selectedPaths) assert.equal(fs.readFileSync(selected, 'utf8'), 'test fixture, not a secret');
    }
    for (const hook of cleanup) await hook();
    assert.deepEqual(fs.readdirSync(cwd), []);
  }
  const link = path.join(f.dir, 'changed-source'); fs.symlinkSync(source, link);
  await assert.rejects(() => withStagedUpload({ paths: [link] }, cwd, async () => assert.fail('must not dispatch')));
  assert.deepEqual(fs.readdirSync(cwd), []);
});
