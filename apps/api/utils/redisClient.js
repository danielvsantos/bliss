/**
 * Shared lazy ioredis client for read-mostly API features (#100).
 *
 * Same lifecycle as the denylist / cooldown clients: created on first use from
 * REDIS_URL, reused by every request a warm lambda serves. Returns `null` when
 * REDIS_URL is unset (local dev without Redis) so callers can degrade instead
 * of failing.
 *
 * `maxRetriesPerRequest: 1` and a 2 s `commandTimeout`: a status read that
 * cannot reach Redis fails fast rather than holding the request open. The
 * offline queue stays on so the first request of a cold lambda waits for the
 * connection instead of failing.
 */

import Redis from 'ioredis';

let redis = null;

export function getRedisClient() {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;

  redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    enableOfflineQueue: true,
    connectTimeout: 5000,
    commandTimeout: 2000,
  });
  redis.on('error', (err) => {
    console.error('[redisClient] Redis error:', err.message);
  });
  return redis;
}

/** Tests only. */
export function __setRedisClientForTests(client) {
  redis = client;
}
