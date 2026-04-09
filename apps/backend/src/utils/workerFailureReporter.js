/**
 * Retry-aware Sentry reporter for BullMQ worker failures.
 *
 * BullMQ fires `worker.on('failed', ...)` on EVERY failed attempt, including
 * intermediate retries that eventually succeed. Calling `Sentry.captureException`
 * blindly from that handler creates false alarms whenever a transient error
 * (Prisma Accelerate cold start, P6004 query timeout, Redis blip) is recovered
 * by BullMQ's retry mechanism.
 *
 * This helper logs every attempt at the appropriate level and only reports to
 * Sentry when the final attempt has been exhausted. Intermediate failures are
 * downgraded to `warn` so they stay visible in logs without paging the oncall.
 *
 * Usage (inside a worker's `worker.on('failed', ...)` handler):
 *
 *   const { reportWorkerFailure } = require('../utils/workerFailureReporter');
 *
 *   worker.on('failed', (job, error) => {
 *       reportWorkerFailure({
 *           workerName: 'portfolioWorker',
 *           job,
 *           error,
 *           extra: { customField: 'value' },  // optional
 *       });
 *   });
 */

const Sentry = require('@sentry/node');
const logger = require('./logger');

/**
 * @param {Object} params
 * @param {string} params.workerName — Short identifier (e.g. "portfolioWorker")
 * @param {import('bullmq').Job | null} params.job — BullMQ job (may be null on queue-level errors)
 * @param {Error} params.error — Thrown error
 * @param {Object} [params.extra] — Additional Sentry context (merged with defaults)
 */
function reportWorkerFailure({ workerName, job, error, extra = {} }) {
    const totalAttempts = job?.opts?.attempts || 1;
    const attemptsMade = job?.attemptsMade || 0;
    const isFinalAttempt = attemptsMade >= totalAttempts;

    const logPayload = {
        worker: workerName,
        jobName: job?.name,
        jobId: job?.id,
        tenantId: job?.data?.tenantId,
        attempt: `${attemptsMade}/${totalAttempts}`,
        willRetry: !isFinalAttempt,
        error: error?.message,
    };

    if (isFinalAttempt) {
        // Final attempt exhausted — this is a real failure, log at error and page Sentry.
        logger.error(`${workerName} job failed (final attempt)`, logPayload);

        Sentry.withScope((scope) => {
            scope.setTag('worker', workerName);
            scope.setTag('jobName', job?.name);
            scope.setExtra('jobId', job?.id);
            scope.setExtra('tenantId', job?.data?.tenantId);
            scope.setExtra('jobData', job?.data);
            scope.setExtra('attemptsMade', attemptsMade);
            scope.setExtra('totalAttempts', totalAttempts);
            for (const [key, value] of Object.entries(extra)) {
                scope.setExtra(key, value);
            }
            Sentry.captureException(error);
        });
    } else {
        // Transient failure — BullMQ will retry. Log at warn so we don't page on
        // recoverable errors (Prisma Accelerate cold start, P6004, Redis blips).
        logger.warn(`${workerName} job failed, will retry`, logPayload);
    }
}

module.exports = { reportWorkerFailure };
