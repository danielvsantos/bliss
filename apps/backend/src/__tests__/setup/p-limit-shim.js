/**
 * CJS shim for p-limit (ESM-only package).
 *
 * The real p-limit creates a concurrency limiter. This shim provides the same
 * API surface: pLimit(concurrency) returns a function that wraps async fns.
 * In tests we don't need real concurrency control — just execute the fn.
 */
function pLimit(_concurrency) {
  const limit = (fn, ...args) => fn(...args);
  limit.activeCount = 0;
  limit.pendingCount = 0;
  limit.clearQueue = () => {};
  return limit;
}

// Support both: const pLimit = require('p-limit') and await import('p-limit')
module.exports = pLimit;
module.exports.default = pLimit;
module.exports.__esModule = true;
