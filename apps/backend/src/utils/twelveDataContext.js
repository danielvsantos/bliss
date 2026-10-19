/**
 * Priority + per-job usage accounting for Twelve Data calls (#150).
 *
 * Callers never pass a priority to `twelveDataService`: a worker processor or
 * route runs inside `runWithTwelveDataContext`, and every Twelve Data call made
 * anywhere below it (stock/crypto/currency services, valuation strategies)
 * reads the priority from AsyncLocalStorage and adds to the same usage record.
 * One `twelve_data_usage` log line is written per job / request that made at
 * least one call.
 *
 * Never throws into the caller: logging failures are swallowed.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { PRIORITY_NAMES } = require('../config/twelveDataCredits');
const logger = require('./logger');

const storage = new AsyncLocalStorage();

function newUsage() {
    return { credits: 0, calls: 0, waitedMs: 0, rateLimited: 0, mode: null };
}

/** The active context, or undefined outside one. */
function getTwelveDataContext() {
    return storage.getStore();
}

function logUsage(ctx) {
    try {
        const { usage } = ctx;
        if (!usage || usage.calls === 0) return;
        logger.info('twelve_data_usage', {
            label: ctx.label,
            queue: ctx.queue,
            jobName: ctx.jobName,
            jobId: ctx.jobId,
            tenantId: ctx.tenantId,
            priority: PRIORITY_NAMES[ctx.priority] || ctx.priority,
            credits: usage.credits,
            calls: usage.calls,
            waitedMs: usage.waitedMs,
            rateLimited: usage.rateLimited,
            mode: usage.mode,
        });
    } catch {
        // logging must never fail a job
    }
}

/**
 * Runs `fn` with a Twelve Data priority context and logs its usage when it
 * settles (resolved or rejected). Nested calls keep the outer context, so a
 * job's usage is counted once.
 */
async function runWithTwelveDataContext({ priority, label, queue, jobName, jobId, tenantId }, fn) {
    if (storage.getStore()) return fn();
    const ctx = { priority, label, queue, jobName, jobId, tenantId, usage: newUsage() };
    try {
        return await storage.run(ctx, fn);
    } finally {
        logUsage(ctx);
    }
}

/**
 * Wraps a BullMQ processor. `priorityOrResolver` is a priority or
 * `(job) => priority` for queues whose jobs differ (security master).
 */
function withTwelveDataPriority(priorityOrResolver, processor) {
    return function twelveDataPriorityProcessor(job, ...rest) {
        const priority = typeof priorityOrResolver === 'function'
            ? priorityOrResolver(job)
            : priorityOrResolver;
        return runWithTwelveDataContext({
            priority,
            label: `${job?.queueName || 'job'}:${job?.name || ''}`,
            queue: job?.queueName,
            jobName: job?.name,
            jobId: job?.id,
            tenantId: job?.data?.tenantId,
        }, () => processor(job, ...rest));
    };
}

/**
 * Express middleware: runs the rest of the request inside a context and logs
 * usage when the response finishes.
 */
function twelveDataRouteContext(priority) {
    return function twelveDataContextMiddleware(req, res, next) {
        const ctx = {
            priority,
            label: `${req.method} ${req.baseUrl || ''}${req.path || ''}`,
            usage: newUsage(),
        };
        res.once('finish', () => logUsage(ctx));
        res.once('close', () => { if (!res.writableFinished) logUsage(ctx); });
        storage.run(ctx, next);
    };
}

module.exports = {
    getTwelveDataContext,
    runWithTwelveDataContext,
    withTwelveDataPriority,
    twelveDataRouteContext,
};
