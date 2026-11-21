const fs = require('node:fs');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { RouterError } = require('./route-policy.cjs');

const UPLOAD_TOOLS = new Set(['browser_file_upload', 'browser_upload_file']);
const PATH_KEYS = ['paths', 'files', 'file', 'filePath', 'path'];
const SECRET_DIRS = ['.ssh', '.gnupg', 'Library/Keychains', '.aws', '.config/gcloud', '.kube', '.docker', '.config/gh'];

function inside(file, directory) {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function secretPath(file, home) {
  const name = path.basename(file).toLowerCase();
  if ((/^\.env(?:\.|$)/.test(name) && !['.env.example', '.env.sample'].includes(name)) || /\.(?:pem|key|p12|pfx|kdbx)$/.test(name) || /^(?:id_rsa|id_ed25519|id_ecdsa|credentials)/.test(name) || name === 'auth.json' || /\.keychain/.test(name)) return true;
  const canonical = (value) => { try { return fs.realpathSync(value); } catch { return value; } };
  if (SECRET_DIRS.some((directory) => inside(file, path.join(home, directory)) || inside(file, canonical(path.join(home, directory))))) return true;
  if (file === path.join(home, '.netrc') || file === canonical(path.join(home, '.netrc'))) return true;
  return false;
}

// Validate all paths before dispatch. Never read file contents or include paths in errors.
function validateUpload(args, { home = os.homedir() } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RouterError('INVALID_UPLOAD_PATH', 'upload arguments must contain file paths');
  const keys = PATH_KEYS.filter((key) => Object.hasOwn(args, key));
  if (keys.length !== 1) throw new RouterError('INVALID_UPLOAD_PATH', 'upload requires exactly one file-path argument');
  const key = keys[0];
  const many = ['paths', 'files'].includes(key);
  const values = many ? args[key] : [args[key]];
  if (!Array.isArray(values)) throw new RouterError('INVALID_UPLOAD_PATH', 'upload paths must be an array');
  let canonicalHome;
  try { canonicalHome = fs.realpathSync(home); } catch { throw new RouterError('INVALID_UPLOAD_PATH', 'upload home directory is unavailable'); }
  const paths = values.map((value) => {
    // Filesystem names are identity, not prose. Preserve Unicode and whitespace;
    // realpath supplies canonical filesystem identity without selecting another file.
    if (typeof value !== 'string' || !value || /[\u0000\uD800-\uDFFF]/u.test(value) || !path.isAbsolute(value)) throw new RouterError('INVALID_UPLOAD_PATH', 'each upload path must be an absolute filename');
    let resolved;
    try { resolved = fs.realpathSync(value); } catch { throw new RouterError('INVALID_UPLOAD_PATH', 'each upload path must exist'); }
    if (secretPath(resolved, canonicalHome) || secretPath(path.resolve(value), canonicalHome)) throw new RouterError('UPLOAD_SECRET_DENIED', 'secret files cannot be uploaded; choose a non-secret file');
    let regular;
    try { regular = fs.statSync(resolved).isFile(); } catch { regular = false; }
    if (!regular) throw new RouterError('INVALID_UPLOAD_PATH', 'each upload path must be a regular file');
    return resolved;
  });
  return { arguments: { ...structuredClone(args), [key]: many ? paths : paths[0] }, fileCount: paths.length };
}

function uploadFileCount(args) {
  if (!args || typeof args !== 'object') return 0;
  return PATH_KEYS.reduce((count, key) => count + (Array.isArray(args[key]) ? args[key].length : typeof args[key] === 'string' ? 1 : 0), 0);
}

// Playwright restricts file access to its isolated cwd. Copy only validated files,
// never widen that workspace or enable unrestricted file access.
async function withStagedUpload(args, directory, call, retainCleanup) {
  const key = PATH_KEYS.find((item) => Object.hasOwn(args, item));
  const many = ['paths', 'files'].includes(key);
  const sources = many ? args[key] : [args[key]];
  const stage = await fsp.mkdtemp(path.join(directory, 'upload-'));
  const cleanup = () => fsp.rm(stage, { recursive: true, force: true });
  let retained = false;
  try {
    const paths = [];
    for (const [index, source] of sources.entries()) {
      const folder = path.join(stage, String(index));
      await fsp.mkdir(folder, { mode: 0o700 });
      const target = path.join(folder, path.basename(source));
      const input = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!(await input.stat()).isFile()) throw new RouterError('INVALID_UPLOAD_PATH', 'upload source is no longer a regular file');
        const output = await fsp.open(target, 'wx', 0o600);
        try {
          // Stream via file handles. Do not load arbitrary files into memory.
          await pipeline(input.createReadStream(), output.createWriteStream());
        } finally { await output.close(); }
      } finally { await input.close(); }
      paths.push(target);
    }
    const result = await call({ ...args, [key]: many ? paths : paths[0] });
    // A file input can read its file later, when the form is submitted. Keep
    // successful selections until the isolated browser has stopped, not just
    // until setInputFiles returns. Router close hooks own the remaining cleanup.
    if (!result?.isError) { retainCleanup(cleanup); retained = true; }
    return result;
  } finally { if (!retained) await cleanup(); }
}

module.exports = { UPLOAD_TOOLS, validateUpload, uploadFileCount, withStagedUpload };
