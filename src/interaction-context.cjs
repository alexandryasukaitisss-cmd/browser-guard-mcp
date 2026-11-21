// Only backend snapshot metadata enters this module. Page prose is not authority.
function metadataText(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\uD800-\uDFFF]/u.test(value)) return '';
  return value.normalize('NFC').replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200D\uFEFF]/g, '').trim();
}

function exactOrigin(value) {
  const source = value instanceof URL ? value.href : metadataText(value);
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch { return undefined; }
}

function snapshotField(field) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return undefined;
  const keys = ['ref', 'selector', 'tag', 'type', 'role', 'name', 'label', 'placeholder', 'autocomplete', 'focused'];
  return Object.fromEntries(keys.map((key) => [key, metadataText(field[key])]));
}

function interactionPage(snapshot, interactive) {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const url = metadataText(snapshot.url);
    if (!exactOrigin(url)) return undefined;
    const fields = Array.isArray(snapshot.elements) ? snapshot.elements : Array.isArray(snapshot.fields) ? snapshot.fields : [];
    return { url, fields: fields.map(snapshotField).filter(Boolean),
    };
  }
  if (typeof snapshot !== 'string') return undefined;
  // Playwright emits a leading header before the accessibility snapshot. Never search
  // the page-controlled snapshot body for a URL or a statement of consent.
  const header = snapshot.split(/^### Snapshot\s*$/m, 1)[0];
  const match = /^(?:### Page(?: state)?\r?\n- Page URL: |URL: )([^\r\n]+)(?:\r?\n|$)/.exec(header);
  if (!match || !exactOrigin(match[1])) return undefined;
  const fields = [];
  if (Array.isArray(interactive)) {
    for (const field of interactive) {
      const normalized = snapshotField(field);
      if (normalized) fields.push(normalized);
    }
  }
  for (const line of snapshot.split('\n')) {
    const field = /^\s*- (textbox|searchbox|combobox|spinbutton) "([^"\r\n]*)"[^\r\n]*\[ref=([a-zA-Z0-9_-]+)\]/.exec(line);
    if (field) fields.push({ role: field[1], name: field[2], ref: field[3], focused: /\[(?:active|focused)\]/.test(line) ? 'true' : '' });
  }
  return { url: metadataText(match[1]), fields };
}

// Match explicit field indicators, never generic “code”, “card”, “PIN” or page prose.
const SENSITIVE_NAME = /(?:^|[^\p{L}\p{N}])(?:card[ _-]+number|номер[ _-]+карты|cvv|cvc|csc|card[ _-]+security[ _-]+code|password|пароль|one[ _-]+time[ _-]+code|одноразовый[ _-]+код|otp|2fa|код[ _-]+из[ _-]+sms)(?=$|[^\p{L}\p{N}])/iu;
const INPUT_TOOLS = new Set(['browser_type', 'browser_fill', 'browser_fill_form', 'browser_select_option', 'browser_press_key']);

function hasSensitiveMetadata(field = {}) {
  if (metadataText(field.type).toLowerCase() === 'password') return true;
  const tokens = metadataText(field.autocomplete).toLowerCase().split(/\s+/);
  if (tokens.some((token) => /^(?:cc-number|cc-csc|cc-exp[a-z-]*|current-password|new-password|one-time-code)$/.test(token))) return true;
  return ['name', 'label', 'placeholder', 'element'].some((key) => SENSITIVE_NAME.test(metadataText(field[key])));
}

function sensitiveInput(tool, args = {}, page) {
  if (!INPUT_TOOLS.has(tool) || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  // Navigation keys do not enter text, including when a sensitive field has focus.
  if (tool === 'browser_press_key' && /^(?:ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Tab|Enter|Escape|Home|End|PageUp|PageDown|F\d{1,2})$/.test(metadataText(args.key))) return false;
  const targets = tool === 'browser_fill_form' ? (Array.isArray(args.fields) ? args.fields : []) : [args];
  return targets.some((target) => {
    if (!target || typeof target !== 'object') return false;
    if (tool === 'browser_fill_form' && ['checkbox', 'radio', 'slider'].includes(metadataText(target.type))) return false;
    if (hasSensitiveMetadata(target)) return true;
    const targetName = metadataText(target.target);
    const ref = metadataText(target.ref) || targetName;
    const selector = metadataText(target.selector) || targetName;
    const fields = Array.isArray(page?.fields) ? page.fields : [];
    return fields.some((field) => ((ref && field.ref === ref) || (selector && field.selector === selector) || (!ref && !selector && field.focused === 'true')) && hasSensitiveMetadata(field));
  });
}

module.exports = { hasSensitiveMetadata, exactOrigin, interactionPage, metadataText, sensitiveInput };
