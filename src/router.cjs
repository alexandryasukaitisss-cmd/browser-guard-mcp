const { EvidenceStore } = require('./evidence.cjs');
const { assertPublicUrl } = require('./net-policy.cjs');
const { RouterError, INTENTS } = require('./route-policy.cjs');
const { CapabilityPolicy } = require('./capability-policy.cjs');
const { interactionPage } = require('./interaction-context.cjs');
const { UPLOAD_TOOLS, validateUpload, uploadFileCount, withStagedUpload } = require('./upload-policy.cjs');

const RESERVED_TOOLS = new Set([
  'browser_route_open', 'browser_route_call', 'browser_evidence_bundle', 'browser_evidence_get',
  'browser_guard_status', 'browser_compatibility_summary', 'browser_capability_activate',
  'browser_capability_status', 'browser_action_prepare',
]);

const GUARD_TOOLS = [
  {
    name: 'browser_route_open',
    description: 'Open a public HTTP(S) page in an isolated browser. The router rejects private, loopback, special-use, non-web-port, and credential-bearing URLs before the browser starts.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, intent: { type: 'string', enum: [...INTENTS] } }, required: ['url'] },
  },
  {
    name: 'browser_route_call',
    description: 'Call an allow-listed browser operation on the active page. Ordinary interaction and non-secret uploads run without a dialog. Card, password and one-time-code entry needs a native one-use confirmation.',
    inputSchema: { type: 'object', properties: { backend: { type: 'string', enum: ['active', 'chrome'] }, tool: { type: 'string' }, arguments: { type: 'object' }, confirmation_id: { type: 'string' } }, required: ['tool'] },
  },
  {
    name: 'browser_capability_activate',
    description: 'Activate a configured capability profile for this router process and a bounded lifetime.',
    inputSchema: { type: 'object', properties: { profile_id: { type: 'string' }, ttl_seconds: { type: 'integer', minimum: 60 } }, required: ['profile_id'] },
  },
  {
    name: 'browser_capability_status',
    description: 'Show the active capability without page data or persistent audit detail.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_action_prepare',
    description: 'Prepare a one-use action ID immediately for ordinary actions; request native approval only for card, password or one-time-code entry.',
    inputSchema: { type: 'object', properties: { backend: { type: 'string', enum: ['active', 'chrome'] }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['tool'] },
  },
  {
    name: 'browser_evidence_bundle',
    description: 'Capture bounded page snapshot and console evidence into this router process only.',
    inputSchema: { type: 'object', properties: { backend: { type: 'string', enum: ['active', 'chrome'] } } },
  },
  {
    name: 'browser_evidence_get',
    description: 'Read a bounded in-memory evidence bundle by id.',
    inputSchema: { type: 'object', properties: { bundle_id: { type: 'string' } }, required: ['bundle_id'] },
  },
  {
    name: 'browser_guard_status',
    description: 'Show non-sensitive router availability and active capability state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_compatibility_summary',
    description: 'Show aggregate, content-free local compatibility diagnostics.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorCategory(error) {
  if (error?.code === 'BACKEND_UNAVAILABLE') return 'backend_unavailable';
  if (error?.code === 'NETWORK_DENIED') return 'policy_denied';
  if (error?.code === 'CAPABILITY_DENIED') return 'capability_denied';
  if (error?.code === 'CONFIRMATION_REQUIRED') return 'confirmation_required';
  if (error?.code === 'CONFIRMATION_DENIED') return 'confirmation_denied';
  if (error?.code === 'UPLOAD_SECRET_DENIED') return 'upload_secret_denied';
  if (error?.code === 'INVALID_UPLOAD_PATH') return 'tool_error';
  if (error?.code === 'TOOL_DENIED') return 'tool_denied';
  if (error?.code === 'INVALID_ARGUMENT') return 'tool_error';
  return 'internal';
}

function firstText(result) {
  const block = result?.content?.find((item) => item.type === 'text');
  if (!block) return '';
  try { return JSON.parse(block.text); } catch { return block.text; }
}

function requireSuccessfulResult(result) {
  if (result?.isError) throw new RouterError('TOOL_ERROR', 'browser backend reported a tool failure');
  return result;
}

class BrowserGuard {
  constructor({ chromeFactory, ledger, evidence = new EvidenceStore(), capabilities = new CapabilityPolicy() }) {
    this.factory = chromeFactory;
    this.backend = null;
    this.backendFailure = null;
    this.ledger = ledger;
    this.evidence = evidence;
    this.capabilities = capabilities;
    this.client = 'unknown';
    this.active = null;
    this.pendingEgressGrantId = undefined;
    this.operationQueue = Promise.resolve();
    this.closeHooks = [];
  }

  addCloseHook(hook) { this.closeHooks.push(hook); }

  setClient(client) {
    this.client = ['codex', 'opencode', 'other'].includes(client) ? client : 'unknown';
  }

  async record(event) {
    try { await this.ledger?.record({ ...event, client: this.client }); } catch { /* diagnostics cannot block browsing */ }
  }

  async getBackend() {
    if (this.backend) return this.backend;
    if (this.backendFailure) throw this.backendFailure;
    try {
      const backend = await this.factory();
      if (!backend) throw new RouterError('BACKEND_UNAVAILABLE', 'browser factory returned no backend');
      if (typeof backend.start === 'function') await backend.start();
      this.backend = backend;
      return backend;
    } catch (error) {
      const failure = error instanceof RouterError ? error : new RouterError('BACKEND_UNAVAILABLE', 'browser could not start');
      this.backendFailure = failure;
      throw failure;
    }
  }

  async backendTools() {
    const backend = await this.getBackend();
    return backend.listTools();
  }

  async listTools() {
    return [...GUARD_TOOLS];
  }

  callTool(name, args = {}) {
    const requestArguments = structuredClone(args);
    const task = this.operationQueue.then(() => this.callToolNow(name, requestArguments), () => this.callToolNow(name, requestArguments));
    this.operationQueue = task.catch(() => {});
    return task;
  }

  async callToolNow(name, args = {}) {
    if (RESERVED_TOOLS.has(name)) return this.callGuardTool(name, args);
    throw new RouterError('TOOL_DENIED', `unknown router tool "${name}"`);
  }

  isEgressHostAllowed(host) {
    try { return this.capabilities.allowsHost({ grantId: this.pendingEgressGrantId || this.active?.grantId, host }); } catch { return false; }
  }

  async callGuardTool(name, args) {
    switch (name) {
      case 'browser_route_open': return this.routeOpen(args);
      case 'browser_route_call': return this.routeCall(args);
      case 'browser_capability_activate': return this.activateCapability(args);
      case 'browser_capability_status': return jsonResult(this.capabilities.status());
      case 'browser_action_prepare': return this.prepareAction(args);
      case 'browser_evidence_bundle': return this.captureEvidence(args);
      case 'browser_evidence_get': return this.getEvidence(args);
      case 'browser_guard_status': return this.status();
      case 'browser_compatibility_summary': return jsonResult(await this.ledger?.summary?.() || { entries: 0, success: 0, failure: 0, by_backend: {} });
      default: throw new RouterError('TOOL_DENIED', `unknown router tool "${name}"`);
    }
  }

  validateIntent(intent) {
    if (!INTENTS.has(intent)) throw new RouterError('INVALID_ARGUMENT', `unknown intent "${intent}"`);
    return intent;
  }

  async routeOpen({ url, intent = 'read' } = {}) {
    let selected = 'none';
    try {
      this.validateIntent(intent);
      const parsedUrl = assertPublicUrl(url);
      const capability = this.capabilities.authorize({ url: parsedUrl, operation: 'navigate' });
      this.pendingEgressGrantId = capability.grant.id;
      selected = 'chrome';
      const browser = await this.getBackend();
      const tools = await browser.listTools();
      if (!tools.some((candidate) => candidate.name === 'browser_navigate')) throw new RouterError('TOOL_DENIED', 'the browser backend does not expose browser_navigate');
      const result = requireSuccessfulResult(await browser.callTool('browser_navigate', { url: parsedUrl.toString() }));
      this.active = { backend: selected, url: parsedUrl.toString(), intent, grantId: capability.grant.id };
      await this.record({ operation: 'route_open', backend: selected, intent, outcome: 'success', category: 'none', capability: capability.operation, duration: capability.grant.durationBucket });
      return jsonResult({ backend: selected, url: parsedUrl.toString(), intent, result: firstText(result) });
    } catch (error) {
      await this.record({ operation: 'route_open', backend: selected, intent, outcome: 'failure', category: errorCategory(error) });
      throw error;
    } finally {
      this.pendingEgressGrantId = undefined;
    }
  }

  selectedBackend(requested = 'active') {
    if (requested === 'active') {
      if (!this.active) throw new RouterError('INVALID_ARGUMENT', 'no active routed browser page');
      return this.active.backend;
    }
    if (requested === 'chrome') return requested;
    throw new RouterError('INVALID_ARGUMENT', `unknown backend "${requested}"`);
  }

  async routeCall({ backend = 'active', tool, arguments: toolArguments = {}, confirmation_id } = {}) {
    const upload = UPLOAD_TOOLS.has(tool);
    const operation = upload ? 'file_upload' : (this.capabilities.operationForTool(tool) === 'interact' || tool === 'browser_scroll') ? 'interaction_action' : 'route_call';
    let fileCount = upload ? uploadFileCount(toolArguments) : undefined;
    let selected = 'none';
    let intent = 'none';
    try {
      selected = this.selectedBackend(backend);
      if (typeof tool !== 'string' || !tool) throw new RouterError('INVALID_ARGUMENT', 'tool is required');
      if (!this.active || this.active.backend !== selected) throw new RouterError('INVALID_ARGUMENT', 'routed tool calls require an active page on the selected backend');
      intent = this.active.intent;
      const tools = await this.backendTools();
      if (!tools.some((candidate) => candidate.name === tool)) throw new RouterError('TOOL_DENIED', `tool "${tool}" is unavailable on ${selected}`);
      let callArguments = structuredClone(toolArguments);
      const interactive = this.capabilities.operationForTool(tool) === 'interact' || tool === 'browser_scroll';
      const page = interactive ? await this.currentInteractionPage() : undefined;
      const targetUrl = tool === 'browser_navigate' ? assertPublicUrl(callArguments.url) : new URL(this.active.url);
      if (tool === 'browser_navigate') callArguments.url = targetUrl.toString();
      const capability = this.capabilities.authorizeTool({ grantId: this.active.grantId, url: targetUrl, tool, arguments: callArguments, confirmationId: confirmation_id, page });
      if (upload) {
        const checked = validateUpload(callArguments);
        callArguments = checked.arguments;
        fileCount = checked.fileCount;
      }
      const browser = await this.getBackend();
      const dispatch = (args) => browser.callTool(tool, args);
      const result = requireSuccessfulResult(await (upload && browser.cwd
        ? withStagedUpload(callArguments, browser.cwd, dispatch, (cleanup) => this.addCloseHook(cleanup))
        : dispatch(callArguments)));
      if (tool === 'browser_navigate') this.active.url = targetUrl.toString();
      if (tool === 'browser_navigate' || tool === 'browser_navigate_back') await this.currentInteractionPage();
      else if (interactive) await this.currentInteractionPage();
      if (tool === 'browser_close') this.active = null;
      await this.record({ operation, ...(upload ? { file_count: fileCount } : {}), backend: selected, intent, outcome: 'success', category: 'none', capability: capability.operation, duration: capability.grant.durationBucket });
      return result;
    } catch (error) {
      await this.record({ operation, ...(upload && fileCount !== undefined ? { file_count: fileCount } : {}), backend: selected, intent, outcome: 'failure', category: errorCategory(error) });
      throw error;
    }
  }

  async activateCapability({ profile_id, ttl_seconds } = {}) {
    try {
      const grant = this.capabilities.activate({ profileId: profile_id, ttlSeconds: ttl_seconds });
      if (this.active) this.active.grantId = grant.id;
      await this.record({ operation: 'capability_activate', backend: 'none', intent: 'none', outcome: 'success', category: 'none', duration: grant.durationBucket });
      return jsonResult(this.capabilities.status());
    } catch (error) {
      await this.record({ operation: 'capability_activate', backend: 'none', intent: 'none', outcome: 'failure', category: errorCategory(error) });
      throw error;
    }
  }

  async prepareAction({ backend = 'active', tool, arguments: toolArguments = {} } = {}) {
    let selected = 'none';
    let intent = 'none';
    try {
      selected = this.selectedBackend(backend);
      if (typeof tool !== 'string' || !tool) throw new RouterError('INVALID_ARGUMENT', 'tool is required');
      if (!this.active || this.active.backend !== selected) throw new RouterError('INVALID_ARGUMENT', 'action confirmation requires an active page on the selected backend');
      intent = this.active.intent;
      const tools = await this.backendTools();
      if (!tools.some((candidate) => candidate.name === tool)) throw new RouterError('TOOL_DENIED', `tool "${tool}" is unavailable on ${selected}`);
      const page = await this.currentInteractionPage();
      if (UPLOAD_TOOLS.has(tool)) validateUpload(toolArguments);
      const confirmation = await this.capabilities.prepareInteraction({ grantId: this.active.grantId, url: this.active.url, tool, arguments: structuredClone(toolArguments), page });
      await this.record({ operation: 'action_prepare', backend: selected, intent, outcome: 'success', category: 'none', capability: 'interact', duration: 'under_1m' });
      return jsonResult({ confirmation_id: confirmation.id, expires_at: new Date(confirmation.expiresAtMs).toISOString(), operation: 'interact' });
    } catch (error) {
      await this.record({ operation: 'action_prepare', backend: selected, intent, outcome: 'failure', category: errorCategory(error), capability: 'interact' });
      throw error;
    }
  }

  async currentInteractionPage() {
    const snapshot = await this.captureValue(['browser_snapshot']);
    const page = interactionPage(snapshot);
    if (page) {
      // Redirects and click-driven navigation must not reuse the last requested URL.
      this.active.url = assertPublicUrl(page.url).toString();
    }
    return page;
  }

  async captureValue(aliases) {
    const toolNames = new Set((await this.backendTools()).map((tool) => tool.name));
    const tool = aliases.find((candidate) => toolNames.has(candidate));
    if (!tool) return undefined;
    try { return firstText(requireSuccessfulResult(await (await this.getBackend()).callTool(tool, {}))); } catch { return undefined; }
  }

  async captureEvidence({ backend = 'active' } = {}) {
    const selected = this.selectedBackend(backend);
    const url = this.active?.backend === selected ? this.active.url : undefined;
    if (!url) throw new RouterError('INVALID_ARGUMENT', 'evidence requires an active routed page on the selected backend');
    const capability = this.capabilities.authorize({ grantId: this.active.grantId, url, operation: 'read' });
    const [snapshot, consoleMessages] = await Promise.all([
      this.captureValue(['browser_snapshot', 'snapshot']),
      this.captureValue(['browser_console_messages', 'console_messages']),
    ]);
    const bundle = this.evidence.capture({ backend: selected, url, snapshot, console: consoleMessages, expiresAtMs: capability.grant.expiresAtMs });
    await this.record({ operation: 'evidence_bundle', backend: selected, intent: this.active.intent, outcome: 'success', category: 'none', capability: 'read', duration: capability.grant.durationBucket });
    return jsonResult(bundle);
  }

  async getEvidence({ bundle_id } = {}) {
    if (typeof bundle_id !== 'string') throw new RouterError('INVALID_ARGUMENT', 'bundle_id is required');
    const bundle = this.evidence.get(bundle_id);
    if (!bundle) throw new RouterError('INVALID_ARGUMENT', 'evidence bundle has expired');
    return jsonResult(bundle);
  }

  async status() {
    return jsonResult({
      active_backend: this.active?.backend || 'none',
      chrome: this.backend ? 'available' : this.backendFailure ? 'unavailable' : 'unchecked',
      capabilities: this.capabilities.status(),
      ledger: await this.ledger?.summary?.() || { entries: 0, success: 0, failure: 0, by_backend: {} },
    });
  }

  async close() {
    try { await this.backend?.stop?.(); } catch { /* best effort shutdown */ }
    for (const hook of this.closeHooks) {
      try { await hook(); } catch { /* best effort shutdown */ }
    }
  }
}

module.exports = { BrowserGuard, GUARD_TOOLS, RouterError };
