const crypto = require('node:crypto');

function boundedString(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class EvidenceStore {
  constructor({ maxBundles = 8, maxTextChars = 32_000, ttlMs = 300_000, now = () => Date.now() } = {}) {
    this.maxBundles = maxBundles;
    this.maxTextChars = maxTextChars;
    this.ttlMs = ttlMs;
    this.now = now;
    this.bundles = new Map();
  }

  nowMs() {
    const value = this.now();
    return typeof value === 'number' ? value : Date.parse(value);
  }

  capture({ backend, url, markdown = '', snapshot = '', links = [], interactive = [], console = [], expiresAtMs } = {}) {
    const normalizedMarkdown = boundedString(markdown, this.maxTextChars);
    const normalizedSnapshot = boundedString(snapshot, this.maxTextChars);
    const capturedAtMs = this.nowMs();
    const bundle = {
      bundle_id: crypto.randomUUID(),
      captured_at: new Date(capturedAtMs).toISOString(),
      backend,
      url,
      content_hash: crypto.createHash('sha256').update(String(normalizedMarkdown || normalizedSnapshot)).digest('hex'),
      markdown: normalizedMarkdown,
      snapshot: normalizedSnapshot,
      links: Array.isArray(links) ? links.slice(0, 50) : [],
      interactive: Array.isArray(interactive) ? interactive.slice(0, 50) : [],
      console: Array.isArray(console) ? console.slice(0, 25) : [],
    };
    this.bundles.set(bundle.bundle_id, { bundle, expiresAtMs: Math.min(expiresAtMs || (capturedAtMs + this.ttlMs), capturedAtMs + this.ttlMs) });
    while (this.bundles.size > this.maxBundles) this.bundles.delete(this.bundles.keys().next().value);
    return clone(bundle);
  }

  get(bundleId) {
    const stored = this.bundles.get(bundleId);
    if (!stored || stored.expiresAtMs <= this.nowMs()) {
      this.bundles.delete(bundleId);
      return undefined;
    }
    return clone(stored.bundle);
  }
}

module.exports = { EvidenceStore };
