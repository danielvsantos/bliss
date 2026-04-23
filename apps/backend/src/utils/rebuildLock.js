/**
 * Rebuild lock release helper.
 *
 * Each admin-triggered rebuild (MANUAL_REBUILD_REQUESTED) acquires a
 * per-(tenant, scope) single-flight lock in `routes/rebuild.js`. The
 * lock's purpose is to block a concurrent second rebuild of the same
 * scope while the first is still in flight — NOT to impose a post-
 * completion cooldown. Releasing the lock the moment the terminal job
 * of the chain finishes means the admin can immediately click again
 * if they need to.
 *
 * Terminal job per scope (what "done" looks like):
 *
 *   full-portfolio   → `value-all-assets`       (portfolio queue)
 *                      — the last step of the full rebuild chain:
 *                        process-portfolio-changes → cash → analytics → value
 *   full-analytics   → `full-rebuild-analytics` (analytics queue)
 *                      — single-job scope, cascade is suppressed
 *   scoped-analytics → `scoped-update-analytics` (analytics queue)
 *                      — single-job scope
 *   single-asset     → `value-portfolio-items`  (portfolio queue)
 *                      — single-job scope
 *
 * For `full-portfolio` to work, `_rebuildMeta` must be propagated along
 * the event chain (see `process-portfolio-changes.js`, `cash-processor.js`,
 * and the `PORTFOLIO_CHANGES_PROCESSED` / `CASH_HOLDINGS_PROCESSED` /
 * `ANALYTICS_RECALCULATION_COMPLETE` cases in `eventSchedulerWorker.js`).
 * The other three scopes have a single-job chain so the meta stays on
 * the initial job.
 *
 * This helper is invoked from each worker's `worker.on('completed')`
 * callback. Idempotent — if the lock has already expired via TTL or the
 * worker fires `completed` twice, `release` is a no-op in both cases.
 */

const { release } = require('./singleFlightLock');
const logger = require('./logger');

const TERMINAL_JOBS = {
    'full-portfolio': 'value-all-assets',
    'full-analytics': 'full-rebuild-analytics',
    'scoped-analytics': 'scoped-update-analytics',
    'single-asset': 'value-portfolio-items',
};

async function maybeReleaseRebuildLock(job) {
    const meta = job?.data?._rebuildMeta;
    if (!meta?.rebuildType) return;

    const expectedName = TERMINAL_JOBS[meta.rebuildType];
    if (!expectedName || expectedName !== job.name) return;

    const tenantId = job.data?.tenantId;
    if (!tenantId) return;

    const key = `rebuild-lock:${tenantId}:${meta.rebuildType}`;
    try {
        await release(key);
        logger.info('[RebuildLock] Released', {
            tenantId,
            scope: meta.rebuildType,
            jobId: job.id,
        });
    } catch (err) {
        // Lock release is best-effort — a failure here just means the
        // admin waits out the TTL. Log and move on.
        logger.warn('[RebuildLock] Failed to release (TTL will clear eventually)', {
            tenantId,
            scope: meta.rebuildType,
            jobId: job.id,
            error: err.message,
        });
    }
}

module.exports = { maybeReleaseRebuildLock, TERMINAL_JOBS };
