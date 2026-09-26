// CJS re-export shim over the shared implementation, mirroring utils/encryption.js.
const { scrubEvent } = require('@bliss/shared/sentry');

module.exports = { scrubEvent };
