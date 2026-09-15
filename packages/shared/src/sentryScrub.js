/**
 * Sentry event scrubbing — the single implementation shared by apps/api
 * (@sentry/nextjs, node + edge + browser) and apps/backend (@sentry/node).
 *
 * Why this exists
 * ---------------
 * `sendDefaultPii` is left false everywhere, but that only governs what the SDK
 * *adds*. It does nothing about what the application hands to
 * `captureException`. Two payload shapes in this codebase carry financial data
 * or credentials into the error object itself:
 *
 *   - Prisma errors embed the offending query payload. Because field encryption
 *     is Prisma middleware, that payload holds *decrypted* transaction
 *     descriptions and account numbers.
 *   - Axios/HTTP client errors carry `config.data` (the transaction descriptions
 *     posted to the LLM provider) and `config.headers` (the provider API key).
 *
 * What it must never do
 * ---------------------
 * Strip the parts that make an issue debuggable. `exception.values[].value`
 * (the message) and `.stacktrace` are deliberately untouched — a Sentry project
 * full of empty issues is the classic failure mode of an over-eager scrubber.
 *
 * Failure policy
 * --------------
 * `beforeSend` returning `null` drops the event *silently and permanently*. A
 * bug in here would therefore be invisible by construction. So the whole body
 * is wrapped in one try/catch that returns the **original, unscrubbed** event.
 * Shipping an unscrubbed event is bad; shipping no events at all and not
 * knowing is worse.
 *
 * This module must have ZERO imports. `apps/backend/src/app.js` initialises
 * Sentry on line 1, before `validateEnv()` runs, and `encryption.js` throws at
 * import time when `ENCRYPTION_SECRET` is unset.
 */

/**
 * Keys whose values are removed wherever they appear in the event tree.
 * Matched case-insensitively against the exact key name, plus a small set of
 * substring patterns for header-ish names.
 */
const DENYLISTED_KEYS = new Set([
  'description',
  'details',
  'accountnumber',
  'account_number',
  'accesstoken',
  'access_token',
  'authorization',
  'x-api-key',
  'apikey',
  'api_key',
  'password',
  'passwordhash',
  'passwordsalt',
  'token',
  'secret',
  'cookie',
  'set-cookie',
  'rawjson',
  'plaidaccesstoken',
]);

/**
 * Sub-objects removed wholesale rather than key-by-key. These are the HTTP
 * client envelopes — every one of their fields is either a credential, a
 * request body, or noise.
 */
const DENYLISTED_CONTAINERS = new Set(['config', 'request', 'response', 'headers']);

/** Strings longer than this are truncated. Stack frames are unaffected. */
const MAX_STRING_LENGTH = 2048;

const REDACTED = '[redacted]';

/**
 * @param {string} key
 * @returns {boolean}
 */
function isDenylistedKey(key) {
  const lower = String(key).toLowerCase();
  if (DENYLISTED_KEYS.has(lower)) return true;
  // Catch composed names like `plaidAccessToken`, `llmApiKey`, `jwtSecret`.
  return (
    lower.endsWith('token') ||
    lower.endsWith('secret') ||
    lower.endsWith('apikey') ||
    lower.endsWith('password')
  );
}

/**
 * Recursively scrub a plain value in place.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} seen  Cycle guard — an error object with a
 *   self-reference must not send this into infinite recursion.
 * @param {number} depth
 * @returns {unknown} the (possibly replaced) value
 */
function scrubValue(value, seen, depth) {
  if (depth > 8) return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}… [truncated]`
      : value;
  }

  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = scrubValue(value[i], seen, depth + 1);
    }
    return value;
  }

  for (const key of Object.keys(value)) {
    if (DENYLISTED_CONTAINERS.has(key.toLowerCase()) || isDenylistedKey(key)) {
      value[key] = REDACTED;
      continue;
    }
    value[key] = scrubValue(value[key], seen, depth + 1);
  }

  return value;
}

/**
 * Sentry `beforeSend` / `beforeSendTransaction` hook.
 *
 * @param {object} event  The Sentry event. Mutated in place, then returned.
 * @param {object} [_hint] Sentry hint (unused — kept for signature parity).
 * @returns {object} the event, never null.
 */
export function scrubEvent(event, _hint) {
  if (!event || typeof event !== 'object') return event;

  try {
    const seen = new WeakSet();

    // Axios/fetch envelopes hang off the top level on some integrations.
    for (const container of DENYLISTED_CONTAINERS) {
      if (container in event) delete event[container];
    }

    if (event.extra) event.extra = scrubValue(event.extra, seen, 0);
    if (event.contexts) event.contexts = scrubValue(event.contexts, seen, 0);
    if (event.tags) event.tags = scrubValue(event.tags, seen, 0);
    if (event.breadcrumbs) event.breadcrumbs = scrubValue(event.breadcrumbs, seen, 0);

    // `event.exception.values[].mechanism.data` is where the SDK parks the
    // non-Error properties it found on the thrown object — i.e. exactly where
    // an axios `config` or a Prisma payload lands. The sibling `value` and
    // `stacktrace` are left strictly alone.
    const values = event.exception?.values;
    if (Array.isArray(values)) {
      for (const entry of values) {
        if (entry && entry.mechanism && entry.mechanism.data) {
          entry.mechanism.data = scrubValue(entry.mechanism.data, seen, 0);
        }
        if (entry && typeof entry.value === 'string' && entry.value.length > MAX_STRING_LENGTH) {
          entry.value = `${entry.value.slice(0, MAX_STRING_LENGTH)}… [truncated]`;
        }
      }
    }

    return event;
  } catch {
    // See "Failure policy" above: return the event unscrubbed rather than
    // dropping it. Never return null from here.
    return event;
  }
}

export default scrubEvent;
