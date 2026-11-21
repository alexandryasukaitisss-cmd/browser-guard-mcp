class RouterError extends Error {
  constructor(code, message, details = undefined) {
    super(`${code}: ${message}`);
    this.name = 'RouterError';
    this.code = code;
    this.details = details;
  }
}

const INTENTS = new Set(['read', 'extract', 'interactive', 'visual']);

module.exports = { RouterError, INTENTS };
