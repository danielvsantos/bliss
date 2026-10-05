/**
 * Processing-status reader (#100).
 *
 * One Redis round-trip per call — a single pipeline of
 *   HGETALL activity:v1:{tenantId}       (per-job entries, written by the backend tracker)
 *   HGETALL activity:v1:{tenantId}:last  (lastCompletedAt per activity type)
 *   EXISTS  bliss:runtime:worker         (the backend worker heartbeat)
 * — turned into the `GET /api/activity` payload by the pure `summarize()` in
 * `@bliss/shared/activity`. No Prisma and no BullMQ: this is safe to poll
 * every few seconds during a full rebuild.
 *
 * Fail-soft: no Redis, or any Redis error, returns `{ available: false }` so the
 * UI hides the status instead of claiming everything is up to date.
 */

import {
  summarize,
  unavailable,
  activityKey,
  lastKey,
  WORKER_HEARTBEAT_KEY,
} from '@bliss/shared/activity';
import { getRedisClient } from './redisClient.js';

export async function readActivity(tenantId, now = Date.now()) {
  const redis = getRedisClient();
  if (!redis || !tenantId) return unavailable(now);

  try {
    const results = await redis
      .pipeline()
      .hgetall(activityKey(tenantId))
      .hgetall(lastKey(tenantId))
      .exists(WORKER_HEARTBEAT_KEY)
      .exec();

    if (!Array.isArray(results) || results.length !== 3 || results.some(([err]) => err)) {
      return unavailable(now);
    }
    const [[, raw], [, last], [, workerKey]] = results;
    return summarize(raw, last, workerKey === 1, now);
  } catch (err) {
    console.error('[activityStore] read failed:', err.message);
    return unavailable(now);
  }
}

/** Failed entries finished after `since` (Date | null) — the PROCESSING_FAILED signal. */
export function countFailuresSince(activity, since) {
  if (!activity?.available) return 0;
  const sinceMs = since ? new Date(since).getTime() : 0;
  return activity.recent.filter((r) => r.state === 'failed' && r.finishedAt && Date.parse(r.finishedAt) > sinceMs).length;
}
