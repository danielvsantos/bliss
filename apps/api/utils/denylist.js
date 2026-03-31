/**
 * Redis-backed JWT denylist.
 *
 * On sign-out the current token's `jti` (JWT ID) is written to Redis with a
 * TTL equal to the remaining lifetime of the token.  withAuth checks every
 * verified token against this store and rejects it with 401 if found.
 *
 * Key schema:  denylist:<jti>  →  "1"  (value irrelevant; presence is the flag)
 * TTL:         set to the token's remaining seconds so keys self-expire.
 *
 * Redis connection is lazy-initialised from REDIS_URL env var.
 * If REDIS_URL is not set (local dev without Redis), operations are no-ops
 * and a warning is logged once.
 */

import Redis from 'ioredis';

let redis = null;
let warnedOnce = false;

function getRedis() {
  if (redis) return redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    if (!warnedOnce) {
      console.warn('[denylist] REDIS_URL not set — JWT denylist is disabled (tokens cannot be revoked)');
      warnedOnce = true;
    }
    return null;
  }

  redis = new Redis(url, {
    // Prevent ioredis from retrying indefinitely on startup
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  redis.on('error', (err) => {
    console.error('[denylist] Redis error:', err.message);
  });

  return redis;
}

/**
 * Add a JWT jti to the denylist.
 * @param {string} jti       — The `jti` claim from the decoded JWT
 * @param {number} ttlSeconds — Seconds until the token expires (use decoded.exp - Date.now()/1000)
 */
export async function addToDenylist(jti, ttlSeconds) {
  const client = getRedis();
  if (!client) return;

  const ttl = Math.max(1, Math.ceil(ttlSeconds)); // at least 1 second
  try {
    await client.set(`denylist:${jti}`, '1', 'EX', ttl);
  } catch (err) {
    console.error('[denylist] Failed to add jti to denylist:', err.message);
  }
}

/**
 * Check whether a JWT jti has been revoked.
 * @param {string} jti
 * @returns {Promise<boolean>} true if the token is in the denylist (revoked)
 */
export async function isRevoked(jti) {
  const client = getRedis();
  if (!client) return false; // No Redis → can't revoke, allow through

  try {
    const exists = await client.exists(`denylist:${jti}`);
    return exists === 1;
  } catch (err) {
    console.error('[denylist] Failed to check denylist:', err.message);
    return false; // Fail open: prefer availability over strict revocation
  }
}
