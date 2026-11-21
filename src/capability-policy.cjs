const crypto = require('node:crypto');
const net = require('node:net');
const { RouterError } = require('./route-policy.cjs');
const { exactOrigin, sensitiveInput } = require('./interaction-context.cjs');

const OPERATIONS = new Set(['navigate', 'read', 'extract', 'observe', 'interact']);
const HOST_PATTERN = /^(?:\*|(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/;
const TOOL_OPERATIONS = new Map([
  ['browser_navigate', 'navigate'], ['browser_navigate_back', 'navigate'],
  ['browser_snapshot', 'read'], ['browser_markdown', 'read'], ['browser_links', 'read'], ['browser_get_attribute', 'read'], ['browser_count', 'read'], ['browser_wait_for_text', 'read'],
  ['browser_extract', 'extract'], ['browser_detect_forms', 'extract'], ['browser_interactive_elements', 'extract'],
  ['browser_console_messages', 'observe'], ['browser_wait_for', 'observe'], ['browser_scroll', 'observe'], ['browser_close', 'observe'],
  ['browser_click', 'interact'], ['browser_hover', 'interact'], ['browser_fill', 'interact'], ['browser_type', 'interact'], ['browser_press_key', 'interact'], ['browser_select_option', 'interact'], ['browser_fill_form', 'interact'], ['browser_file_upload', 'interact'], ['browser_upload_file', 'interact'],
]);

function configError(message) { return new RouterError('INVALID_CONFIG', message); }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  if (value === undefined) return null;
  return value;
}

function argumentDigest(argumentsValue) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(argumentsValue || {}))).digest('hex');
}

function normalizeHost(value) {
  const host = String(value || '').toLowerCase().replace(/\.$/, '');
  if (!host || net.isIP(host)) throw new RouterError('CAPABILITY_DENIED', 'capability requires a DNS hostname');
  return host;
}

function hostFromUrlOrHost(value) {
  if (value instanceof URL) return value.hostname;
  const source = String(value || '');
  if (source.includes('://')) {
    try { return new URL(source).hostname; } catch { throw new RouterError('CAPABILITY_DENIED', 'capability requires a valid public origin'); }
  }
  return source;
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') throw configError('capability profile must be an object');
  if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(raw.id)) throw configError('capability profile id is invalid');
  if (!Array.isArray(raw.hosts) || raw.hosts.length < 1 || raw.hosts.length > 32) throw configError(`capability profile ${raw.id} must define 1-32 host patterns`);
  const hosts = raw.hosts.map((host) => {
    if (typeof host !== 'string') throw configError(`capability profile ${raw.id} host pattern is invalid`);
    const normalized = host.toLowerCase().replace(/\.$/, '');
    if (!HOST_PATTERN.test(normalized)) throw configError(`capability profile ${raw.id} host pattern is invalid`);
    return normalized;
  });
  if (!Array.isArray(raw.operations) || raw.operations.length < 1) throw configError(`capability profile ${raw.id} must define operations`);
  const operations = [...new Set(raw.operations)];
  if (operations.some((operation) => !OPERATIONS.has(operation))) throw configError(`capability profile ${raw.id} has an unknown operation`);
  if (!Number.isInteger(raw.maxTtlSeconds) || raw.maxTtlSeconds < 60 || raw.maxTtlSeconds > 28_800) throw configError(`capability profile ${raw.id} maxTtlSeconds must be 60-28800`);
  return Object.freeze({ id: raw.id, hosts: Object.freeze(hosts), operations: Object.freeze(operations), maxTtlSeconds: raw.maxTtlSeconds });
}

function normalizeCapabilityConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw configError('capabilities must be an object');
  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > 16) throw configError('capabilities must define 1-16 profiles');
  const profiles = raw.profiles.map(normalizeProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw configError('capability profile ids must be unique');
  const defaultProfile = raw.defaultProfile;
  if (defaultProfile !== undefined && !profiles.some((profile) => profile.id === defaultProfile)) throw configError('capabilities.defaultProfile must name a configured profile');
  const confirmationTtlSeconds = raw.confirmationTtlSeconds === undefined ? 60 : raw.confirmationTtlSeconds;
  if (!Number.isInteger(confirmationTtlSeconds) || confirmationTtlSeconds < 15 || confirmationTtlSeconds > 300) throw configError('capabilities.confirmationTtlSeconds must be 15-300');
  return Object.freeze({ profiles: Object.freeze(profiles), defaultProfile, confirmationTtlSeconds });
}

function hostMatches(pattern, host) {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

function durationBucket(seconds) {
  if (seconds <= 60) return 'under_1m';
  if (seconds <= 300) return '1m_to_5m';
  if (seconds <= 900) return '5m_to_15m';
  return 'over_15m';
}

class CapabilityPolicy {
  constructor({ config, now = () => Date.now(), approvalPrompt = async () => false } = {}) {
    this.config = normalizeCapabilityConfig(config || {
      defaultProfile: 'public-read',
      profiles: [{ id: 'public-read', hosts: ['*'], operations: ['navigate', 'read', 'extract', 'observe'], maxTtlSeconds: 3_600 }],
    });
    this.now = now;
    this.approvalPrompt = approvalPrompt;
    this.profiles = new Map(this.config.profiles.map((profile) => [profile.id, profile]));
    this.grants = new Map();
    this.confirmations = new Map();
    this.activeGrantId = undefined;
    if (this.config.defaultProfile) this.activate({ profileId: this.config.defaultProfile });
  }

  prune() {
    const now = this.now();
    for (const [id, grant] of this.grants) if (grant.expiresAtMs <= now) this.grants.delete(id);
    for (const [id, confirmation] of this.confirmations) if (confirmation.expiresAtMs <= now) this.confirmations.delete(id);
    if (this.activeGrantId && !this.grants.has(this.activeGrantId)) this.activeGrantId = undefined;
  }

  activeGrant(grantId = this.activeGrantId) {
    this.prune();
    const grant = this.grants.get(grantId);
    if (!grant) throw new RouterError('CAPABILITY_DENIED', 'an unexpired capability profile is required');
    return grant;
  }

  activate({ profileId, ttlSeconds } = {}) {
    this.prune();
    const profile = this.profiles.get(profileId);
    if (!profile) throw new RouterError('CAPABILITY_DENIED', 'capability profile is not configured');
    const seconds = ttlSeconds === undefined ? profile.maxTtlSeconds : ttlSeconds;
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > profile.maxTtlSeconds) throw new RouterError('INVALID_ARGUMENT', 'capability lifetime exceeds the configured profile limit');
    const grant = Object.freeze({
      id: crypto.randomUUID(),
      profile,
      expiresAtMs: this.now() + (seconds * 1_000),
      durationBucket: durationBucket(seconds),
    });
    this.grants.set(grant.id, grant);
    this.activeGrantId = grant.id;
    return grant;
  }

  status() {
    this.prune();
    const grant = this.grants.get(this.activeGrantId);
    return grant ? {
      active: true,
      profile_id: grant.profile.id,
      expires_at: new Date(grant.expiresAtMs).toISOString(),
      operations: [...grant.profile.operations],
    } : { active: false };
  }

  authorize({ grantId = this.activeGrantId, url, operation }) {
    const grant = this.activeGrant(grantId);
    if (!OPERATIONS.has(operation) || !grant.profile.operations.includes(operation)) throw new RouterError('CAPABILITY_DENIED', 'capability profile does not permit this operation');
    const host = normalizeHost(hostFromUrlOrHost(url));
    if (!grant.profile.hosts.some((pattern) => hostMatches(pattern, host))) throw new RouterError('CAPABILITY_DENIED', 'capability profile does not permit this hostname');
    return { grant, host, operation };
  }

  allowsHost({ grantId, host } = {}) {
    const grant = this.activeGrant(grantId);
    return grant.profile.hosts.some((pattern) => hostMatches(pattern, normalizeHost(host)));
  }

  operationForTool(tool) { return TOOL_OPERATIONS.get(tool); }

  authorizeTool({ grantId, url, tool, arguments: toolArguments = {}, confirmationId, page } = {}) {
    const operation = this.operationForTool(tool);
    if (!operation) throw new RouterError('TOOL_DENIED', 'guard denies unclassified, cookie/storage, and code-execution tools');
    const authorization = this.authorize({ grantId, url, operation });
    if (operation !== 'interact' && tool !== 'browser_scroll') return authorization;
    const sensitive = sensitiveInput(tool, toolArguments, page);
    if (confirmationId !== undefined) {
      this.consumeConfirmation({ confirmationId, grantId: authorization.grant.id, origin: exactOrigin(url), tool, arguments: toolArguments, sensitive });
    } else if (sensitive) {
      throw new RouterError('CONFIRMATION_REQUIRED', 'card, password or one-time-code entry requires a native one-use confirmation');
    }
    return authorization;
  }

  async prepareInteraction({ grantId, url, tool, arguments: toolArguments = {}, page } = {}) {
    const operation = this.operationForTool(tool);
    if (operation !== 'interact' && tool !== 'browser_scroll') throw new RouterError('INVALID_ARGUMENT', 'only interactive tools can be prepared for confirmation');
    const authorization = this.authorize({ grantId, url, operation });
    const origin = exactOrigin(url);
    if (!origin) throw new RouterError('INVALID_ARGUMENT', 'confirmation requires an exact HTTP(S) origin');
    const sensitive = sensitiveInput(tool, toolArguments, page);
    // Freeze the digest before awaiting the native user decision.
    const digest = argumentDigest(toolArguments);
    if (sensitive) {
      const approved = await this.approvalPrompt({ host: authorization.host, origin, tool, expiresAtMs: this.now() + (this.config.confirmationTtlSeconds * 1_000) });
      if (approved !== true && approved !== 'once') throw new RouterError('CONFIRMATION_DENIED', 'sensitive browser input was not approved');
    }
    this.prune();
    if (this.activeGrantId !== authorization.grant.id || !this.grants.has(authorization.grant.id)) throw new RouterError('CONFIRMATION_DENIED', 'capability changed or expired during confirmation');
    const confirmation = Object.freeze({
      id: crypto.randomUUID(),
      grantId: authorization.grant.id,
      origin,
      tool,
      argumentDigest: digest,
      sensitive,
      expiresAtMs: this.now() + (this.config.confirmationTtlSeconds * 1_000),
    });
    this.confirmations.set(confirmation.id, confirmation);
    return confirmation;
  }

  consumeConfirmation({ confirmationId, grantId, origin, tool, arguments: toolArguments, sensitive }) {
    this.prune();
    const confirmation = this.confirmations.get(confirmationId);
    this.confirmations.delete(confirmationId);
    if (!confirmation || confirmation.expiresAtMs <= this.now() || confirmation.grantId !== grantId || confirmation.origin !== origin || confirmation.tool !== tool || confirmation.argumentDigest !== argumentDigest(toolArguments) || (sensitive && !confirmation.sensitive)) {
      throw new RouterError('CONFIRMATION_DENIED', 'interactive confirmation is missing, expired, mismatched, or already used');
    }
    return confirmation;
  }
}

module.exports = { CapabilityPolicy, OPERATIONS, TOOL_OPERATIONS, argumentDigest, durationBucket, hostFromUrlOrHost, hostMatches, normalizeCapabilityConfig };
