/**
 * Shared retry / timeout / backoff scaffolding for all LLM adapters.
 *
 * Every provider (Gemini, OpenAI, Anthropic) shares the same rate-limit-aware
 * retry model:
 *   • Up to MAX_RETRIES attempts
 *   • Rate-limit errors (429 / quota exhaustion) back off in minute-scale windows
 *   • Other transient errors back off with exponential delay (1s, 2s, 4s, ...)
 *   • A hard per-call timeout prevents infinite hangs
 *
 * Provider-specific differences (error shape detection, model names, SDK calls)
 * live in each adapter file. This module stays provider-agnostic.
 */

const logger = require('../../utils/logger');

// ─── Rate-limit / retry config ────────────────────────────────────────────────
const MAX_RETRIES = 5;                   // Survive quota windows
const BASE_DELAY_MS = 1000;              // 1s → 2s → 4s for non-429 errors
const RATE_LIMIT_BASE_DELAY_MS = 60_000; // 60s → 120s → 180s for 429
// Successful classification/embedding calls from any provider complete in well
// under 5s. 12s gives generous headroom for transient slowness (spikes, cold
// starts, network jitter) without stalling a whole batch on a single stuck
// call — the retry loop absorbs the aborted attempt.
const DEFAULT_CALL_TIMEOUT_MS = 12_000;  // 12s hard cap per classification/embedding call
const INSIGHT_CALL_TIMEOUT_MS = 60_000;  // 60s for insight generation (longer prompts, more output)

/**
 * Sleep helper for backoff delays.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a hard timeout. Rejects if the promise doesn't settle in time.
 *
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label — used in the timeout error message
 * @returns {Promise<T>}
 * @template T
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Compute the backoff delay for a given attempt.
 *
 * @param {number} attempt — 1-indexed attempt number
 * @param {boolean} isRateLimit — whether the most recent failure was a 429
 * @returns {number} delay in milliseconds
 */
function computeBackoff(attempt, isRateLimit) {
  return isRateLimit
    ? RATE_LIMIT_BASE_DELAY_MS * attempt       // 60s, 120s, 180s, ...
    : BASE_DELAY_MS * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s, 16s
}

/**
 * Execute an async operation with retry + timeout + rate-limit-aware backoff.
 *
 * @param {Object} opts
 * @param {() => Promise<T>} opts.operation  — the async call to execute
 * @param {(error: Error) => boolean} opts.isRateLimitError — detector for rate-limit errors
 * @param {string} opts.label — identifier for logs and timeout messages
 * @param {number} [opts.timeoutMs] — override the default 30s timeout
 * @param {() => void} [opts.onRetry] — hook called after a failed attempt, before sleep.
 *                                       Use this to mutate request state (e.g. append
 *                                       correction feedback to a prompt).
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry({ operation, isRateLimitError, label, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, onRetry }) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await withTimeout(operation(), timeoutMs, label);
    } catch (error) {
      lastError = error;

      if (attempt === MAX_RETRIES) {
        logger.error(`${label} failed after ${MAX_RETRIES} attempts: ${error.message}`);
        throw error;
      }

      const rateLimit = Boolean(isRateLimitError && isRateLimitError(error));
      const delay = computeBackoff(attempt, rateLimit);

      logger.warn(
        `${label} attempt ${attempt} failed, retrying in ${Math.round(delay / 1000)}s: ${error.message}`
      );

      if (onRetry) onRetry(error, attempt);

      await sleep(delay);
    }
  }

  // Unreachable — the loop either returns or throws. Included so static analysis is happy.
  throw lastError;
}

module.exports = {
  withRetry,
  withTimeout,
  sleep,
  computeBackoff,
  MAX_RETRIES,
  BASE_DELAY_MS,
  RATE_LIMIT_BASE_DELAY_MS,
  DEFAULT_CALL_TIMEOUT_MS,
  INSIGHT_CALL_TIMEOUT_MS,
};
