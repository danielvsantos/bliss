/**
 * eToro copy trading helpers for the API (#143): the client factory (one
 * client per request, built from the key pair being checked or stored) and
 * the per-connection "Sync now" cooldown.
 *
 * See docs/specs/api/28-etoro-api.md.
 */

import { createEtoroClient } from '@bliss/shared/etoro';
import { getRedisClient } from './redisClient.js';

/** "Sync now" cooldown per connection (R4). */
export const SYNC_COOLDOWN_SECONDS = 15 * 60;

let clientFactory = createEtoroClient;

/** @param {{ apiKey: string, userKey: string }} keys */
export function etoroClient(keys) {
  return clientFactory(keys);
}

/** Tests only: replace the client factory (null restores the real one). */
export function __setEtoroClientFactoryForTests(factory) {
  clientFactory = factory || createEtoroClient;
}

const cooldownKey = (connectionId) => `etoro:sync:cooldown:${connectionId}`;
const memoryCooldowns = new Map(); // connectionId → epoch ms when the cooldown ends

/**
 * Seconds left on a connection's "Sync now" cooldown (0 = none). Redis when
 * configured (shared across instances), otherwise in-process. Fail-open: a
 * Redis error allows the sync, which is cheap and deduplicated by the worker.
 */
export async function syncCooldownRemaining(connectionId) {
  const redis = getRedisClient();
  if (redis) {
    try {
      const ttl = await redis.ttl(cooldownKey(connectionId));
      return ttl > 0 ? ttl : 0;
    } catch {
      return 0;
    }
  }
  const until = memoryCooldowns.get(connectionId);
  const left = until ? Math.ceil((until - Date.now()) / 1000) : 0;
  return left > 0 ? left : 0;
}

export async function armSyncCooldown(connectionId) {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(cooldownKey(connectionId), '1', 'EX', SYNC_COOLDOWN_SECONDS);
      return;
    } catch {
      // fall through to memory
    }
  }
  memoryCooldowns.set(connectionId, Date.now() + SYNC_COOLDOWN_SECONDS * 1000);
}

/** Tests only. */
export function __clearSyncCooldownsForTests() {
  memoryCooldowns.clear();
}
