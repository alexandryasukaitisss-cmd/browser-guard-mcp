const { appendFile, chmod, mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const OPERATIONS = new Set(['route_open', 'route_call', 'evidence_bundle', 'capability_activate', 'action_prepare', 'interaction_action', 'file_upload']);
const BACKENDS = new Set(['chrome', 'none']);
const INTENTS = new Set(['read', 'extract', 'interactive', 'visual', 'none']);
const OUTCOMES = new Set(['success', 'failure']);
const CATEGORIES = new Set(['none', 'backend_unavailable', 'policy_denied', 'capability_denied', 'confirmation_required', 'confirmation_denied', 'tool_denied', 'upload_secret_denied', 'tool_error', 'internal']);
const CAPABILITIES = new Set(['none', 'navigate', 'read', 'extract', 'observe', 'interact']);
const DURATIONS = new Set(['none', 'under_1m', '1m_to_5m', '5m_to_15m', 'over_15m']);
const CLIENTS = new Set(['unknown', 'codex', 'opencode', 'other']);

function allowed(value, set, fallback) {
  return set.has(value) ? value : fallback;
}

class CompatibilityLedger {
  constructor({ dir, maxEntries = 200, now = () => new Date().toISOString() }) {
    this.dir = dir;
    this.path = join(dir, 'compatibility.jsonl');
    this.maxEntries = maxEntries;
    this.now = now;
    this.queue = Promise.resolve();
  }

  async ensure() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }

  async records() {
    try {
      const body = await readFile(this.path, 'utf8');
      return body.split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async record(event) {
    this.queue = this.queue.then(async () => {
      await this.ensure();
      const entry = {
        version: 1,
        ...(event.operation === 'file_upload' && Number.isSafeInteger(event.file_count) && event.file_count >= 0 ? { file_count: event.file_count } : {}),
        at: this.now(),
        operation: allowed(event.operation, OPERATIONS, 'route_call'),
        backend: allowed(event.backend, BACKENDS, 'none'),
        intent: allowed(event.intent, INTENTS, 'none'),
        outcome: allowed(event.outcome, OUTCOMES, 'failure'),
        category: allowed(event.category, CATEGORIES, 'internal'),
        capability: allowed(event.capability, CAPABILITIES, 'none'),
        duration: allowed(event.duration, DURATIONS, 'none'),
        client: allowed(event.client, CLIENTS, 'unknown'),
      };
      const entries = [...await this.records(), entry].slice(-this.maxEntries);
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
    });
    return this.queue;
  }

  async summary() {
    await this.queue;
    const entries = await this.records();
    const summary = { entries: entries.length, success: 0, failure: 0, by_backend: {}, by_capability: {}, by_client: {} };
    for (const entry of entries) {
      summary[entry.outcome] += 1;
      summary.by_backend[entry.backend] = (summary.by_backend[entry.backend] || 0) + 1;
      summary.by_capability[entry.capability] = (summary.by_capability[entry.capability] || 0) + 1;
      summary.by_client[entry.client] = (summary.by_client[entry.client] || 0) + 1;
    }
    return summary;
  }
}

module.exports = { CompatibilityLedger };
