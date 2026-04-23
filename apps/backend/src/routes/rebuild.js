/**
 * Admin Maintenance endpoints — manual rebuild triggers + status.
 *
 *   POST /api/admin/rebuild/trigger
 *     Body: { tenantId, scope, requestedBy?, payload? }
 *     - scope: 'full-portfolio' | 'full-analytics' | 'scoped-analytics' | 'single-asset'
 *     - payload.earliestDate required for scoped-analytics
 *     - payload.portfolioItemId required for single-asset
 *
 *     Acquires a per-(tenant, scope) single-flight lock via Redis
 *     (SET NX EX 3600). If the lock is already held, responds 409
 *     with the remaining TTL so the UI can display an ETA. Otherwise
 *     emits a MANUAL_REBUILD_REQUESTED event and returns 202.
 *
 *   GET /api/admin/rebuild/status?tenantId=...
 *     Returns:
 *       {
 *         locks:   [{ scope, ttlSeconds }], // per-scope single-flight state
 *         current: Job[],                   // in-flight rebuild jobs
 *         recent:  Job[],                   // last 20 completed/failed rebuilds
 *         assets:  [{ id, symbol, currency, category: { name } }],
 *                                           // portfolio items for the
 *                                           // single-asset rebuild picker —
 *                                           // included here to avoid a
 *                                           // second fetch against the
 *                                           // live-priced /api/portfolio/items
 *                                           // endpoint from the Maintenance tab
 *       }
 *     Jobs are filtered to those carrying `data._rebuildMeta` — i.e.
 *     only admin-triggered ones, not nightly crons or transaction-
 *     driven scoped updates that happen to land on the same queue.
 *
 * All routes require `apiKeyAuth`. Tenant-admin enforcement lives in
 * the API proxy (`apps/api/pages/api/admin/rebuild.js`), not here;
 * the backend trusts `tenantId` passed by the API layer.
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const apiKeyAuth = require('../middleware/apiKeyAuth');
const { enqueueEvent } = require('../queues/eventsQueue');
const { acquire, isHeld } = require('../utils/singleFlightLock');
const { getPortfolioQueue } = require('../queues/portfolioQueue');
const { getAnalyticsQueue } = require('../queues/analyticsQueue');
const prisma = require('../../prisma/prisma.js');

const LOCK_TTL_SECONDS = 60 * 60; // 1 hour
const RECENT_LIMIT = 20;

const VALID_SCOPES = new Set([
    'full-portfolio',
    'full-analytics',
    'scoped-analytics',
    'single-asset',
]);

const lockKey = (tenantId, scope) => `rebuild-lock:${tenantId}:${scope}`;

function validatePayload(scope, payload) {
    if (scope === 'scoped-analytics') {
        if (!payload?.earliestDate) {
            return 'payload.earliestDate is required for scope=scoped-analytics';
        }
        const date = new Date(payload.earliestDate);
        if (Number.isNaN(date.getTime())) {
            return 'payload.earliestDate must be a valid ISO date';
        }
    }
    if (scope === 'single-asset') {
        if (!payload?.portfolioItemId || typeof payload.portfolioItemId !== 'number') {
            return 'payload.portfolioItemId (number) is required for scope=single-asset';
        }
    }
    return null;
}

// ─── POST /api/admin/rebuild/trigger ────────────────────────────────────────
router.post('/trigger', apiKeyAuth, async (req, res) => {
    const { tenantId, scope, requestedBy, payload } = req.body || {};

    if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
    }
    if (!scope || !VALID_SCOPES.has(scope)) {
        return res.status(400).json({
            error: `scope must be one of: ${[...VALID_SCOPES].join(', ')}`,
        });
    }
    const payloadError = validatePayload(scope, payload);
    if (payloadError) {
        return res.status(400).json({ error: payloadError });
    }

    const key = lockKey(tenantId, scope);
    try {
        const acquired = await acquire(key, LOCK_TTL_SECONDS);
        if (!acquired) {
            const { ttlSeconds } = await isHeld(key);
            logger.info('[Rebuild] Declined — rebuild already in progress', {
                tenantId, scope, ttlSeconds,
            });
            return res.status(409).json({
                error: 'Rebuild already in progress',
                scope,
                ttlSeconds,
            });
        }

        const requestedAt = new Date().toISOString();
        await enqueueEvent('MANUAL_REBUILD_REQUESTED', {
            tenantId,
            scope,
            requestedBy: requestedBy || null,
            requestedAt,
            payload: payload || null,
            source: 'admin-maintenance-ui',
        });

        logger.info('[Rebuild] Manual rebuild enqueued', {
            tenantId, scope, requestedBy: requestedBy || null,
        });
        res.status(202).json({
            status: 'accepted',
            scope,
            requestedAt,
            lockTtlSeconds: LOCK_TTL_SECONDS,
        });
    } catch (error) {
        logger.error('[Rebuild] Failed to trigger rebuild', {
            tenantId, scope, error: error.message, stack: error.stack,
        });
        res.status(500).json({ error: 'Failed to trigger rebuild' });
    }
});

// ─── GET /api/admin/rebuild/status ──────────────────────────────────────────

// Project a BullMQ `Job` into a compact, UI-friendly shape. We expose just
// enough to render the history panel without leaking every field on the
// internal job object.
function serializeJob(job, state) {
    const meta = job.data?._rebuildMeta || null;
    return {
        id: job.id,
        name: job.name,
        state,
        progress: typeof job.progress === 'number' ? job.progress : 0,
        rebuildType: meta?.rebuildType || null,
        requestedBy: meta?.requestedBy || null,
        requestedAt: meta?.requestedAt || null,
        startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        failedReason: job.failedReason || null,
        attemptsMade: job.attemptsMade || 0,
    };
}

async function getRebuildJobsForTenant(tenantId) {
    // Pull from both queues. Rebuild jobs live on either portfolio or
    // analytics depending on scope.
    //
    // Perf note: the previous implementation called `getJobs(allStates,
    // 0, 200)` then per-job `getState()` to resolve which state bucket
    // each job belonged to. Under contention from an active rebuild,
    // those N+1 `getState` calls serialized against the worker's own
    // Redis traffic and the endpoint timed out (10s proxy timeout fired
    // regularly with 4-10s response times). Splitting by state tags each
    // bucket up front — state comes from which list we asked for, not
    // from a follow-up roundtrip per job.
    const portfolioQueue = getPortfolioQueue();
    const analyticsQueue = getAnalyticsQueue();

    const STATES = ['active', 'waiting', 'delayed', 'completed', 'failed'];
    // 30 per state is comfortably above the 20-entry history cap and
    // the at-most-4 concurrent-rebuilds case. The previous 200 was
    // overkill and wasted Redis ops on jobs we'd filter out anyway.
    const LIMIT = 30;

    const fetchStateJobs = async (queue, state) => {
        const jobs = await queue.getJobs([state], 0, LIMIT);
        return jobs.map((j) => ({ job: j, state }));
    };

    const buckets = await Promise.all([
        ...STATES.map((s) => fetchStateJobs(portfolioQueue, s)),
        ...STATES.map((s) => fetchStateJobs(analyticsQueue, s)),
    ]);

    const all = buckets.flat();

    // Filter to admin-triggered rebuilds (those carrying `_rebuildMeta`)
    // for this tenant only. Everything else — nightly crons, transaction-
    // driven scoped updates — is noise on this surface.
    return all.filter(
        ({ job }) => job?.data?._rebuildMeta && job?.data?.tenantId === tenantId,
    );
}

router.get('/status', apiKeyAuth, async (req, res) => {
    const { tenantId } = req.query;
    if (!tenantId || typeof tenantId !== 'string') {
        return res.status(400).json({ error: 'tenantId query parameter is required' });
    }

    try {
        // 1. Per-scope lock state.
        const scopes = [...VALID_SCOPES];
        const locks = await Promise.all(
            scopes.map(async (scope) => {
                const { held, ttlSeconds } = await isHeld(lockKey(tenantId, scope));
                return { scope, held, ttlSeconds };
            }),
        );

        // 2. Jobs carrying `_rebuildMeta` for this tenant, across portfolio
        //    and analytics queues.
        //
        // 3. Portfolio items for the single-asset picker. Ships alongside
        //    status so the Maintenance tab doesn't need a second fetch
        //    against /api/portfolio/items — which triggers live price
        //    fetches for every asset (40+ HTTP calls to TwelveData) just
        //    to populate a dropdown. Here we just read id+symbol+currency+
        //    category.name from the DB. Run in parallel with the jobs
        //    query since both are independent.
        const [jobs, assets] = await Promise.all([
            getRebuildJobsForTenant(tenantId),
            prisma.portfolioItem.findMany({
                where: {
                    tenantId,
                    category: { type: { in: ['Investments', 'Asset', 'Debt'] } },
                },
                select: {
                    id: true,
                    symbol: true,
                    currency: true,
                    category: { select: { name: true } },
                },
                orderBy: { symbol: 'asc' },
            }),
        ]);

        // Active/waiting/delayed → "current" bucket; completed/failed → "recent" bucket.
        const ACTIVE_STATES = new Set(['active', 'waiting', 'delayed']);
        const currentJobs = jobs
            .filter(({ state }) => ACTIVE_STATES.has(state))
            .map(({ job, state }) => serializeJob(job, state));

        const recentJobs = jobs
            .filter(({ state }) => !ACTIVE_STATES.has(state))
            .map(({ job, state }) => serializeJob(job, state))
            .sort((a, b) => {
                // Newest first by finishedAt (falling back to requestedAt).
                const aTime = Date.parse(a.finishedAt || a.requestedAt || 0);
                const bTime = Date.parse(b.finishedAt || b.requestedAt || 0);
                return bTime - aTime;
            })
            .slice(0, RECENT_LIMIT);

        // The "current" display slot is the oldest active rebuild (usually
        // there's at most one — the single-flight lock enforces that — but
        // different scopes can run in parallel, so we may have up to four).
        currentJobs.sort((a, b) => {
            const aTime = Date.parse(a.startedAt || a.requestedAt || 0);
            const bTime = Date.parse(b.startedAt || b.requestedAt || 0);
            return aTime - bTime;
        });

        res.json({
            locks,
            current: currentJobs,
            recent: recentJobs,
            assets,
        });
    } catch (error) {
        logger.error('[Rebuild] Failed to fetch rebuild status', {
            tenantId, error: error.message, stack: error.stack,
        });
        res.status(500).json({ error: 'Failed to fetch rebuild status' });
    }
});

module.exports = router;
