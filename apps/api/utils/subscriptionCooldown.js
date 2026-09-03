/**
 * Soft per-tenant cooldown for the Subscriptions "Scan now" action.
 *
 * Prefers a Redis key (shared across serverless instances); falls back to an
 * in-process Map when REDIS_URL is unset (local dev / single-instance Docker).
 * Fail-open: any Redis error is swallowed and the scan is allowed — the worst
 * case is one extra detection job, which is cheap and idempotent.
 *
 * Mirrors SUBSCRIPTION_REFRESH_COOLDOWN_MIN in
 * apps/backend/src/config/classificationConfig.js.
 */

import Redis from 'ioredis';

export const REFRESH_COOLDOWN_SECONDS = 30 * 60; // 30 minutes

let redis = null;
let redisDisabled = false;
const memoryStore = new Map(); // tenantId -> epoch-ms when cooldown expires

function getRedis() {
  if (redisDisabled) return null;
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisDisabled = true;
    return null;
  }
  redis = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: false, lazyConnect: false });
  redis.on('error', () => {});
  return redis;
}

const key = (tenantId) => `subs:refresh:${tenantId}`;

/**
 * @returns {Promise<number>} seconds remaining on the cooldown, or 0 if none.
 */
export async function getRefreshCooldownRemaining(tenantId) {
  const client = getRedis();
  if (client) {
    try {
      const ttl = await client.ttl(key(tenantId));
      return ttl > 0 ? ttl : 0;
    } catch {
      // fall through to memory
    }
  }
  const expiresAt = memoryStore.get(tenantId);
  if (!expiresAt) return 0;
  const remaining = Math.ceil((expiresAt - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

/** Arm the cooldown for `tenantId`. */
export async function armRefreshCooldown(tenantId) {
  const client = getRedis();
  if (client) {
    try {
      await client.set(key(tenantId), '1', 'EX', REFRESH_COOLDOWN_SECONDS);
      return;
    } catch {
      // fall through to memory
    }
  }
  memoryStore.set(tenantId, Date.now() + REFRESH_COOLDOWN_SECONDS * 1000);
}
