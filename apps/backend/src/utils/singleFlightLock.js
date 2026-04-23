/**
 * Redis-backed single-flight lock with TTL.
 *
 * Used by the admin Maintenance endpoints to prevent a second rebuild
 * from starting while one is already in progress. Two clicks 15 minutes
 * apart would otherwise run two independent rebuild chains end-to-end
 * (observed 2026-04-22 — the manual rebuild ran 70 minutes partly
 * because the second trigger wasn't debounced).
 *
 * Semantics:
 *
 *   - `acquire(key, ttlSeconds)` returns `true` if the lock was taken,
 *     `false` if it was already held. Uses `SET NX EX` for atomic
 *     acquire-or-fail in a single round-trip.
 *
 *   - `release(key)` unconditionally deletes the lock. Safe to call
 *     from a "complete" path; if the lock already expired (a rebuild
 *     that exceeded its TTL), this is a no-op.
 *
 *   - `isHeld(key)` returns `{ held: boolean, ttlSeconds: number }`
 *     for status queries. `ttlSeconds` is `-1` if the key doesn't
 *     exist (`-2` in raw Redis), `null` otherwise.
 *
 * The TTL is a safety net — the happy path releases the lock when the
 * rebuild completes. But if the worker crashes or loses its BullMQ
 * lock mid-run, the TTL ensures a subsequent admin click isn't blocked
 * forever.
 *
 * Key convention (caller's responsibility): `rebuild-lock:<tenantId>:<type>`.
 * Namespacing by type means a `full-portfolio` rebuild doesn't block a
 * separate `full-analytics` rebuild — they touch mostly-disjoint data.
 */

const { getRedisConnection } = require('./redis');

async function acquire(key, ttlSeconds) {
  const redis = getRedisConnection();
  const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

async function release(key) {
  const redis = getRedisConnection();
  await redis.del(key);
}

async function isHeld(key) {
  const redis = getRedisConnection();
  const ttl = await redis.ttl(key);
  // ioredis `ttl` returns -2 if key doesn't exist, -1 if key exists without expire.
  // We treat -2 as "not held". -1 (no expire) shouldn't happen since we always set EX.
  if (ttl === -2) return { held: false, ttlSeconds: null };
  return { held: true, ttlSeconds: ttl };
}

module.exports = { acquire, release, isHeld };
