const { chmod, mkdir, mkdtemp, readFile, rm } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { join, resolve } = require('node:path');
const { BrowserGuard } = require('./router.cjs');
const { PublicEgressProxy } = require('./egress-proxy.cjs');
const { CompatibilityLedger } = require('./ledger.cjs');
const { McpChildClient } = require('./mcp-child.cjs');
const { RouterError } = require('./route-policy.cjs');
const { CapabilityPolicy, normalizeCapabilityConfig } = require('./capability-policy.cjs');
const { exactOrigin } = require('./interaction-context.cjs');

const execFileAsync = promisify(execFile);

const FORBIDDEN_CHROME_FLAGS = new Set([
  '--allow-unrestricted-file-access', '--user-data-dir', '--storage-state', '--save-session', '--proxy-server',
  '--proxy-bypass', '--no-sandbox', '--endpoint', '--extension', '--shared-browser-context', '--secrets', '--output-dir', '--output-max-size', '--snapshot-mode',
]);

const DEFAULT_CAPABILITIES = Object.freeze({
  defaultProfile: 'public-read',
  profiles: [
    { id: 'public-read', hosts: ['*'], operations: ['navigate', 'read', 'extract', 'observe'], maxTtlSeconds: 3_600 },
    { id: 'public-interact', hosts: ['*'], operations: ['navigate', 'read', 'extract', 'observe', 'interact'], maxTtlSeconds: 900 },
  ],
  confirmationTtlSeconds: 60,
});

function requireString(value, key) {
  if (typeof value !== 'string' || !value) throw new RouterError('INVALID_CONFIG', `${key} must be a non-empty string`);
  return value;
}

function stringArray(value, key) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new RouterError('INVALID_CONFIG', `${key} must be an array of strings`);
  return value;
}

function forbiddenArgument(args, flags) {
  return args.find((arg) => flags.has(arg) || [...flags].some((flag) => arg.startsWith(`${flag}=`)));
}

function normalizeConfig(value) {
  if (!value || typeof value !== 'object') throw new RouterError('INVALID_CONFIG', 'configuration must be an object');
  const extraArgs = stringArray(value.chrome?.extraArgs, 'chrome.extraArgs');
  const forbidden = forbiddenArgument(extraArgs, FORBIDDEN_CHROME_FLAGS);
  if (forbidden) throw new RouterError('INVALID_CONFIG', `chrome.extraArgs cannot contain ${forbidden}`);
  return {
    runtimeDir: resolve(requireString(value.runtimeDir, 'runtimeDir')),
    chrome: {
      nodeCommand: value.chrome?.nodeCommand === undefined ? process.execPath : requireString(value.chrome.nodeCommand, 'chrome.nodeCommand'),
      playwrightCli: requireString(value.chrome?.playwrightCli, 'chrome.playwrightCli'),
      extraArgs,
    },
    timeoutMs: Number.isInteger(value.timeoutMs) && value.timeoutMs >= 1_000 ? value.timeoutMs : 20_000,
    ledgerMaxEntries: Number.isInteger(value.ledgerMaxEntries) && value.ledgerMaxEntries >= 1 ? value.ledgerMaxEntries : 200,
    capabilities: normalizeCapabilityConfig(value.capabilities || DEFAULT_CAPABILITIES),
  };
}

async function loadConfig(path) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new RouterError('INVALID_CONFIG', 'cannot read router configuration'); }
  return normalizeConfig(parsed);
}

function buildChromeArgs(chrome, proxyUrl, outputDir) {
  return [
    chrome.playwrightCli,
    '--browser', 'chrome',
    '--headless',
    '--isolated',
    '--block-service-workers',
    '--output-mode', 'stdout',
    '--image-responses', 'omit',
    '--output-dir', outputDir,
    '--proxy-server', proxyUrl,
    '--proxy-bypass', '<-loopback>',
    ...chrome.extraArgs,
  ];
}

function minimalChildEnv(source = process.env) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_CTYPE', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return Object.fromEntries(allowed.flatMap((key) => typeof source[key] === 'string' ? [[key, source[key]]] : []));
}

function createMacosApprovalPrompt({ timeoutMs = 60_000, runAppleScript = execFileAsync } = {}) {
  return async ({ origin }) => {
    const site = exactOrigin(origin);
    if (!site) return false;
    const onceButton = 'Allow once';
    const denyButton = 'Deny';
    const message = [
      'Allow: the agent is entering card data, a password, or a one-time code.',
      `Site: ${site}.`,
      'Scope: this action only, inside the current capability grant.',
      'Effect: the page or the data on the site.',
      'This approval does not cover other actions.',
      'Rollback limit: submitted data may remain on the site.',
    ].join('\n');
    const buttons = [denyButton, onceButton].map((button) => JSON.stringify(button)).join(', ');
    const script = `display dialog ${JSON.stringify(message)} with title "Browser permission" buttons {${buttons}} default button ${JSON.stringify(denyButton)} cancel button ${JSON.stringify(denyButton)}`;
    try {
      const { stdout } = await runAppleScript('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs, maxBuffer: 1_024, env: minimalChildEnv() });
      return stdout.trim() === `button returned:${onceButton}` ? 'once' : false;
    } catch {
      return false;
    }
  };
}

function createRouter(config) {
  const ledger = new CompatibilityLedger({ dir: config.runtimeDir, maxEntries: config.ledgerMaxEntries });
  let proxy;
  let chromeOutputDir;
  const childEnv = minimalChildEnv();
  let router;
  const getProxy = async () => {
    if (!proxy) proxy = await new PublicEgressProxy({ isHostAllowed: (host) => router?.isEgressHostAllowed(host) || false }).start();
    return proxy;
  };
  router = new BrowserGuard({
    ledger,
    capabilities: new CapabilityPolicy({ config: config.capabilities, approvalPrompt: createMacosApprovalPrompt() }),
    chromeFactory: async () => {
      await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
      const chromeProxy = await getProxy();
      if (!chromeOutputDir) {
        chromeOutputDir = await mkdtemp(join(config.runtimeDir, 'chrome-output-'));
        await chmod(chromeOutputDir, 0o700);
      }
      return new McpChildClient({
        name: 'Chrome',
        command: config.chrome.nodeCommand,
        args: buildChromeArgs(config.chrome, chromeProxy.url, chromeOutputDir),
        cwd: chromeOutputDir,
        env: childEnv,
        timeoutMs: config.timeoutMs,
      });
    },
  });
  router.addCloseHook(async () => {
    await proxy?.close();
    if (chromeOutputDir) await rm(chromeOutputDir, { recursive: true, force: true });
  });
  return router;
}

module.exports = { RouterError, buildChromeArgs, createMacosApprovalPrompt, createRouter, loadConfig, minimalChildEnv, normalizeConfig };
