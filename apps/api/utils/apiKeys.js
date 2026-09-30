import { createHash, randomBytes } from 'crypto';
import prisma from '../prisma/prisma.js';
import { timingSafeCompare } from './timingSafeCompare.js';
import { TOKEN_PREFIX, redactIntegrationTokens } from './integrationPolicy.js';

/**
 * Integration API keys (#84).
 *
 * Format: `bliss_<prefix>_<secret>`
 *   prefix — 8 base62 chars, public, unique; the DB lookup key and what the UI shows
 *   secret — 43 base62 chars (≈256 bits)
 *
 * Only `sha256(fullToken)` (hex) is stored. The plaintext is returned once, on
 * creation, and is never logged. A plain hash is deliberate: the token is 256
 * bits of randomness, so a slow KDF or a pepper adds nothing, and binding it to
 * ENCRYPTION_SECRET would break every token on key rotation.
 */

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const PREFIX_LENGTH = 8;
export const SECRET_LENGTH = 43;

const TOKEN_PATTERN = new RegExp(
  `^${TOKEN_PREFIX}([A-Za-z0-9]{${PREFIX_LENGTH}})_([A-Za-z0-9]{${SECRET_LENGTH}})$`,
);

/** Minimum gap between two lastUsedAt/lastUsedIp writes for the same key. */
export const LAST_USED_THROTTLE_MS = 60 * 1000;

/** Expiry choices offered by the management API. `null` = no expiry. */
export const ALLOWED_EXPIRY_DAYS = [30, 90, 365, null];

/**
 * Uniform base62 string from crypto.randomBytes. Bytes ≥ 248 (= 62 × 4) are
 * rejected so every character is equally likely (no modulo bias).
 *
 * @param {number} length
 * @returns {string}
 */
export function randomBase62(length) {
  let out = '';
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (let i = 0; i < bytes.length && out.length < length; i += 1) {
      if (bytes[i] < 248) out += BASE62[bytes[i] % 62];
    }
  }
  return out;
}

/**
 * @param {string} token
 * @returns {string} lowercase hex SHA-256
 */
export function hashApiKey(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * @returns {{ token: string, prefix: string, keyHash: string }}
 */
export function generateApiKey() {
  const prefix = randomBase62(PREFIX_LENGTH);
  const secret = randomBase62(SECRET_LENGTH);
  const token = `${TOKEN_PREFIX}${prefix}_${secret}`;
  return { token, prefix, keyHash: hashApiKey(token) };
}

/**
 * @param {unknown} token
 * @returns {{ prefix: string } | null} null for anything malformed.
 */
export function parseApiKey(token) {
  if (typeof token !== 'string') return null;
  const match = token.match(TOKEN_PATTERN);
  return match ? { prefix: match[1] } : null;
}

/**
 * @param {number|null|undefined} expiresInDays
 * @param {Date} [now]
 * @returns {Date|null}
 */
export function expiryFromDays(expiresInDays, now = new Date()) {
  if (expiresInDays === null || expiresInDays === undefined) return null;
  return new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
}

/**
 * Derived key status for display. Revocation wins over expiry.
 *
 * @param {{ revokedAt?: Date|null, expiresAt?: Date|null }} key
 * @param {Date} [now]
 * @returns {'active'|'revoked'|'expired'}
 */
export function keyStatus(key, now = new Date()) {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt) <= now) return 'expired';
  return 'active';
}

/**
 * Resolve a presented token to its key, integration and creating user.
 *
 * @param {string} token
 * @param {Date} [now]
 * @returns {Promise<
 *   | { ok: true, apiKey: object, integration: object, user: { id, tenantId, email, role } }
 *   | { ok: false, code: 'TOKEN_INVALID'|'TOKEN_REVOKED'|'TOKEN_EXPIRED' }
 * >}
 */
export async function verifyApiKey(token, now = new Date()) {
  const parsed = parseApiKey(token);
  if (!parsed) return { ok: false, code: 'TOKEN_INVALID' };

  const apiKey = await prisma.apiKey.findUnique({
    where: { prefix: parsed.prefix },
    include: { integration: true },
  });

  // Unknown prefix (including keys removed by a cascade) or wrong secret.
  if (!apiKey || !timingSafeCompare(hashApiKey(token), apiKey.keyHash)) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }

  const { integration } = apiKey;
  if (!integration || integration.tenantId !== apiKey.tenantId) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }
  if (apiKey.revokedAt || integration.revokedAt) {
    return { ok: false, code: 'TOKEN_REVOKED' };
  }
  if (apiKey.expiresAt && apiKey.expiresAt <= now) {
    return { ok: false, code: 'TOKEN_EXPIRED' };
  }

  // Separate query (not a nested include) so the Prisma extension decrypts the
  // creator's email like it does on the JWT path.
  const user = await prisma.user.findUnique({
    where: { id: integration.createdByUserId },
    select: { id: true, tenantId: true, email: true, role: true },
  });
  if (!user || user.tenantId !== apiKey.tenantId) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }

  return { ok: true, apiKey, integration, user };
}

// Per-instance memo of the last lastUsedAt write per key. On a multi-instance
// deploy (Vercel) each instance keeps its own; the conditional updateMany below
// is what keeps the DB write rate at ≤1/min per key across instances.
const lastTouched = new Map();

/**
 * Record key usage, at most once per key per LAST_USED_THROTTLE_MS.
 * Fire-and-forget: never throws, never delays the request.
 *
 * @param {{ id: string }} apiKey
 * @param {string|null} ip
 * @param {Date} [now]
 */
export function touchLastUsed(apiKey, ip, now = new Date()) {
  const nowMs = now.getTime();
  const previous = lastTouched.get(apiKey.id);
  if (previous !== undefined && nowMs - previous < LAST_USED_THROTTLE_MS) return;
  lastTouched.set(apiKey.id, nowMs);

  const cutoff = new Date(nowMs - LAST_USED_THROTTLE_MS);
  Promise.resolve()
    .then(() => prisma.apiKey.updateMany({
      where: {
        id: apiKey.id,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }],
      },
      data: { lastUsedAt: now, lastUsedIp: ip ? String(ip).slice(0, 64) : null },
    }))
    .catch((err) => {
      console.warn('apiKeys: lastUsedAt update failed', { apiKeyId: apiKey.id, message: redactIntegrationTokens(err?.message) });
    });
}

/** Test hook: clear the in-memory throttle. */
export function _resetLastUsedThrottle() {
  lastTouched.clear();
}

/**
 * Client IP as seen by the API, same sources as the rate limiter.
 *
 * @param {object} req
 * @returns {string|null}
 */
export function requestIp(req) {
  return (
    req.headers?.['x-real-ip']
    || req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || null
  );
}
