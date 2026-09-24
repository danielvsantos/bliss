import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison, length-guarded.
 *
 * `crypto.timingSafeEqual` **throws** when the two buffers differ in length. An
 * unguarded call turns a wrong-length credential into a 500 instead of a 401 —
 * both a worse response and, ironically, a louder oracle than the timing leak
 * it was meant to close. The length check short-circuits first.
 *
 * This does leak the *length* of the expected value through timing. That is the
 * standard, accepted trade-off: length is not the secret.
 *
 * ESM counterpart of apps/backend/src/utils/timingSafeCompare.js — the two are
 * deliberately duplicated rather than shared, following the same convention as
 * the paired validateEnv and encryption modules, because the apps do not share
 * a module system.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

export default timingSafeCompare;
