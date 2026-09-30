const { getRedisConnection } = require('../utils/redis');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ── Field mergers ────────────────────────────────────────────────────────────
//
// A debounced job replaces the pending one, so every field the job reads must
// be merged with the pending job's value — otherwise the newest event's value
// silently wins and the earlier events' work is lost (#92). A merger is
// `(existingValue, incomingValue) => mergedValue`; `undefined` means the field
// is absent, and returning `undefined` drops it from the merged job. Each
// merger fixes what "absent" means for its field: nothing to do, or everything.

const dedupeKey = (item) => (item !== null && typeof item === 'object' ? JSON.stringify(item) : `${typeof item}:${item}`);

/** Content-based union of two arrays, first occurrence wins, order preserved. */
function unionArrays(a = [], b = []) {
    const seen = new Set();
    const out = [];
    for (const item of [...(a || []), ...(b || [])]) {
        const key = dedupeKey(item);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(item);
        }
    }
    return out;
}

/** Array union; an absent side contributes nothing. */
function union(existing, incoming) {
    if (existing === undefined && incoming === undefined) return undefined;
    return unionArrays(existing, incoming);
}

/** Array union; an absent side means "all" (e.g. no accountIds = full rebuild), so the result is absent too. */
function unionOrAll(existing, incoming) {
    if (existing === undefined || incoming === undefined) return undefined;
    return unionArrays(existing, incoming);
}

/** Keep whichever side is present, preferring the newest (e.g. `_rebuildMeta`). */
function keepPresent(existing, incoming) {
    return incoming !== undefined ? incoming : existing;
}

/**
 * Cash processor scope `{ currency?, accountId?, year?, month? }`. An absent
 * scope (or an absent key) means "all", and the processor rebuilds from the
 * scope's oldest transaction to the present, so the merge is the narrowest
 * scope covering both: the earliest year, and currency / account / month only
 * when both sides agree. The processor takes a single currency, so a union of
 * two currencies widens to all currencies.
 */
function cashScope(existing, incoming) {
    if (!existing || !incoming) return undefined;
    const merged = {};
    if (existing.year !== undefined && incoming.year !== undefined) {
        merged.year = Math.min(existing.year, incoming.year);
        if (existing.month !== undefined && existing.year === incoming.year && existing.month === incoming.month) {
            merged.month = existing.month;
        }
    }
    if (existing.currency !== undefined && existing.currency === incoming.currency) merged.currency = existing.currency;
    if (existing.accountId !== undefined && existing.accountId === incoming.accountId) merged.accountId = existing.accountId;
    return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Consolidated analytics scope `{ earliestDate, filters: { type, group, currency, country } }`
 * (see `consolidateScopes` in eventSchedulerWorker). An absent scope contributes
 * nothing; an absent `earliestDate` / filter key means "unbounded" and so wins.
 * The result is the earliest date and the per-dimension union of filter values.
 */
function analyticsScope(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;

    const merged = {};
    if (existing.earliestDate && incoming.earliestDate) {
        merged.earliestDate = existing.earliestDate < incoming.earliestDate ? existing.earliestDate : incoming.earliestDate;
    }
    const a = existing.filters || {};
    const b = incoming.filters || {};
    const filters = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (Array.isArray(a[key]) && a[key].length > 0 && Array.isArray(b[key]) && b[key].length > 0) {
            filters[key] = unionArrays(a[key], b[key]);
        }
    }
    merged.filters = filters;
    return merged;
}

const mergers = { union, unionOrAll, keepPresent, cashScope, analyticsScope };

/**
 * Schedules a debounced job using Redis to aggregate data from high-frequency events.
 *
 * @param {import('bullmq').Queue} queue - The BullMQ queue instance.
 * @param {string} jobName - The name of the job to schedule.
 * @param {object} jobData - The data for the job, including tenantId and the data to be aggregated.
 * @param {string} aggregationKey - The key within jobData (e.g., 'scopes', 'portfolioItemIds') that holds the array to be aggregated.
 * @param {number} delayInSeconds - The debounce delay in seconds.
 * @param {Object<string, Function>} [fieldMergers] - Mergers (see `mergers`) for every other
 *   field the job reads. Fields without a merger take the newest event's value. All call
 *   sites sharing a `jobName` share one Redis key and must pass the same mergers.
 */
async function scheduleDebouncedJob(queue, jobName, jobData, aggregationKey, delayInSeconds, fieldMergers = {}) {
    const redis = getRedisConnection();
    const tenantId = jobData.tenantId;
    if (!tenantId) {
        logger.warn(`Debounce service called for job ${jobName} without a tenantId. Skipping.`);
        return;
    }

    const redisKey = `debounce:${jobName}:tenant:${tenantId}`;

    try {
        // Fetch the existing debounced job details from Redis.
        const existingJobString = await redis.get(redisKey);
        let existingJob = null;
        if (existingJobString) {
            try {
                existingJob = JSON.parse(existingJobString);
            } catch (e) {
                logger.error(`Failed to parse existing debounced job from Redis for key ${redisKey}.`, { error: e.message, value: existingJobString });
            }
        }

        // If a job is already scheduled, remove it. We will replace it with a new one.
        if (existingJob && existingJob.jobId) {
            const job = await queue.getJob(existingJob.jobId);
            if (job) {
                try {
                    await job.remove();
                    logger.info(`[Debounce] Canceled pending job ${existingJob.jobId} for ${jobName} to extend scope.`);
                } catch (e) {
                    logger.warn(`[Debounce] Could not remove job ${existingJob.jobId}, it may have already run.`, { error: e.message });
                }
            }
        }

        // Aggregate the new data with any existing data.
        const aggregatedJobData = {
            ...jobData,
            [aggregationKey]: unionArrays((existingJob && existingJob[aggregationKey]) || [], jobData[aggregationKey] || []),
        };

        // Merge every other scope-bearing field, so no earlier event's scope is dropped.
        if (existingJob) {
            for (const [field, merge] of Object.entries(fieldMergers)) {
                if (field === aggregationKey) continue;
                const merged = merge(existingJob[field], jobData[field]);
                if (merged === undefined) {
                    delete aggregatedJobData[field];
                } else {
                    aggregatedJobData[field] = merged;
                }
            }
        }

        // Schedule the new job with the aggregated data.
        const newJob = await queue.add(jobName, aggregatedJobData, {
            delay: delayInSeconds * 1000,
            jobId: uuidv4() // Assign a unique ID to make it easier to track/cancel
        });

        // Store the new job's details back in Redis with an expiry.
        const newJobDetails = {
            jobId: newJob.id,
            ...aggregatedJobData
        };
        await redis.set(redisKey, JSON.stringify(newJobDetails), 'EX', delayInSeconds + 5); // 5-seconds buffer

        logger.info(`[Debounce] Scheduled new job ${newJob.id} for ${jobName} with aggregated scope.`, { tenantId, newScope: aggregatedJobData[aggregationKey] });

    } catch (error) {
        logger.error(`[Debounce] Error in scheduleDebouncedJob for ${jobName}.`, {
            tenantId,
            error: error.message,
            stack: error.stack,
        });
    }
}

module.exports = { scheduleDebouncedJob, mergers };
