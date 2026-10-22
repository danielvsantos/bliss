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
// Classification and embedding calls. Healthy calls finish in 1-4s, but the
// default classification models are thinking models (gemini-3-flash-preview
// decides its own thinking budget) and can take well over 5s on ambiguous
// descriptions or under provider load. A tight cap does not make those calls
// faster: it aborts work that was about to succeed and pays for it again on
// the retry, so a slow-but-healthy provider turns into a wave of timeouts and
// FAILED Plaid rows. 20s only cuts genuinely stuck calls.
const DEFAULT_CALL_TIMEOUT_MS = 20_000;
// Insight generation: long system prompts, structured output and a pro-tier
// thinking model (gemini-3.1-pro-preview) — 60s was not enough for the
// quarterly/annual tiers.
const DEFAULT_INSIGHT_CALL_TIMEOUT_MS = 120_000;

/**
 * Read a positive integer millisecond override from the environment, falling
 * back to `fallback` when unset or invalid.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function timeoutFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn(`${name}="${raw}" is not a positive integer (ms); using ${fallback}ms`);
    return fallback;
  }
  return value;
}

const CALL_TIMEOUT_MS = timeoutFromEnv('LLM_CALL_TIMEOUT_MS', DEFAULT_CALL_TIMEOUT_MS);
const INSIGHT_CALL_TIMEOUT_MS = timeoutFromEnv('LLM_INSIGHT_TIMEOUT_MS', DEFAULT_INSIGHT_CALL_TIMEOUT_MS);

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
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
 * @param {number} [opts.timeoutMs] — override the default call timeout (CALL_TIMEOUT_MS)
 * @param {() => void} [opts.onRetry] — hook called after a failed attempt, before sleep.
 *                                       Use this to mutate request state (e.g. append
 *                                       correction feedback to a prompt).
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry({ operation, isRateLimitError, label, timeoutMs = CALL_TIMEOUT_MS, onRetry }) {
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
  DEFAULT_INSIGHT_CALL_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  INSIGHT_CALL_TIMEOUT_MS,
  timeoutFromEnv,
};
