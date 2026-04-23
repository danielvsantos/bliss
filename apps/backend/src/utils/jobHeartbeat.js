/**
 * BullMQ job lock heartbeat helper.
 *
 * BullMQ v5 auto-renews a running job's lock at `lockDuration / 2` on a
 * timer. In practice that timer can miss its renewal window when:
 *
 *   - The event loop is starved by a long single-await (e.g. a
 *     `$transaction([...500 upserts])` against Prisma Accelerate where the
 *     remote side is throttling).
 *   - Redis has a transient blip exactly when the renewal tries to fire.
 *
 * When the renewal fails the lock expires. BullMQ's stalled-job checker
 * then picks the job up and re-runs it from scratch — producing the
 * "could not renew lock for job <id>" / "Missing lock for job <id>.
 * moveToDelayed" error pair observed in production during full tenant
 * rebuilds.
 *
 * This helper gives long-running handlers a cheap, explicit renewal they
 * can call at natural yield points in their loops. The returned function:
 *
 *   - Is a no-op when `job` or `token` is falsy (tests, handlers invoked
 *     outside worker context).
 *   - Self rate-limits via `intervalMs` so hot-path code can call it
 *     every iteration without worrying about Redis traffic.
 *   - Rethrows on renewal failure so the handler aborts cleanly rather
 *     than continuing to write against a hijacked job slot.
 *
 * Usage:
 *
 *   const { createHeartbeat } = require('../utils/jobHeartbeat');
 *
 *   const processJob = async (job, token) => {
 *     const heartbeat = createHeartbeat(job, token, {
 *       intervalMs: 60_000,
 *       lockDurationMs: 300_000,
 *       name: 'analyticsWorker',
 *     });
 *     for (const item of items) {
 *       await heartbeat();
 *       await doWork(item);
 *     }
 *   };
 */

const logger = require('./logger');

function createHeartbeat(job, token, opts = {}) {
  const {
    intervalMs = 30_000,
    lockDurationMs = 300_000,
    name = 'heartbeat',
  } = opts;

  // No-op when we have no job/token — lets handler code call heartbeat()
  // unconditionally (tests, direct invocations, pseudo-job spreads where
  // the token was not attached). Keeps call sites clean.
  if (!job || !token || typeof job.extendLock !== 'function') {
    return async () => {};
  }

  let lastExtend = Date.now();

  return async () => {
    const elapsed = Date.now() - lastExtend;
    if (elapsed < intervalMs) return;
    // Update timestamp before the await so back-to-back callers don't
    // pile up in-flight extendLock requests if the first one is slow.
    lastExtend = Date.now();
    try {
      await job.extendLock(token, lockDurationMs);
    } catch (err) {
      logger.warn(`[${name}] Failed to extend job lock — aborting`, {
        jobId: job.id,
        error: err.message,
      });
      throw err;
    }
  };
}

module.exports = { createHeartbeat };
