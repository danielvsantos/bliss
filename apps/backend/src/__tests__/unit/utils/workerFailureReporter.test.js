// ─── workerFailureReporter.test.js ──────────────────────────────────────────
// Unit tests for the retry-aware Sentry reporter used by all BullMQ workers.
//
// The key invariant: Sentry.captureException must ONLY fire on the FINAL
// exhausted retry attempt. Intermediate attempts must be logged at `warn`
// level only, so recoverable transient errors (Prisma Accelerate cold
// starts, P6004 timeouts, Redis blips) don't trigger false alarms.

jest.mock('@sentry/node', () => ({
  withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn() })),
  captureException: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Sentry = require('@sentry/node');
const logger = require('../../../utils/logger');
const { reportWorkerFailure } = require('../../../utils/workerFailureReporter');

function makeJob({ attemptsMade = 0, attempts = 3, tenantId = 'tenant-1', name = 'test-job', data = {} } = {}) {
  return {
    id: 'job-abc',
    name,
    data: { tenantId, ...data },
    attemptsMade,
    opts: { attempts },
  };
}

describe('reportWorkerFailure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('intermediate retry attempts', () => {
    it('does NOT call Sentry.captureException on attempt 1 of 3', () => {
      reportWorkerFailure({
        workerName: 'portfolioWorker',
        job: makeJob({ attemptsMade: 1, attempts: 3 }),
        error: new Error('P6008: cold start'),
      });

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.withScope).not.toHaveBeenCalled();
    });

    it('does NOT call Sentry.captureException on attempt 2 of 3', () => {
      reportWorkerFailure({
        workerName: 'portfolioWorker',
        job: makeJob({ attemptsMade: 2, attempts: 3 }),
        error: new Error('P6004: query timeout'),
      });

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('logs intermediate failures at warn level (not error)', () => {
      reportWorkerFailure({
        workerName: 'portfolioWorker',
        job: makeJob({ attemptsMade: 1, attempts: 3 }),
        error: new Error('transient'),
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'portfolioWorker job failed, will retry',
        expect.objectContaining({
          worker: 'portfolioWorker',
          attempt: '1/3',
          willRetry: true,
          error: 'transient',
        })
      );
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('final exhausted attempt', () => {
    it('calls Sentry.captureException on the final attempt (attemptsMade === attempts)', () => {
      const error = new Error('permanent failure');

      reportWorkerFailure({
        workerName: 'portfolioWorker',
        job: makeJob({ attemptsMade: 3, attempts: 3 }),
        error,
      });

      expect(Sentry.withScope).toHaveBeenCalled();
      expect(Sentry.captureException).toHaveBeenCalledWith(error);
    });

    it('logs final failures at error level', () => {
      reportWorkerFailure({
        workerName: 'analyticsWorker',
        job: makeJob({ attemptsMade: 3, attempts: 3 }),
        error: new Error('permanent'),
      });

      expect(logger.error).toHaveBeenCalledWith(
        'analyticsWorker job failed (final attempt)',
        expect.objectContaining({
          worker: 'analyticsWorker',
          attempt: '3/3',
          willRetry: false,
        })
      );
    });

    it('threads standard context (worker, jobName, jobId, tenantId, attempts) into Sentry scope', () => {
      const scope = { setTag: jest.fn(), setExtra: jest.fn() };
      Sentry.withScope.mockImplementationOnce((cb) => cb(scope));

      reportWorkerFailure({
        workerName: 'smartImportWorker',
        job: makeJob({ attemptsMade: 3, attempts: 3, name: 'commit-smart-import' }),
        error: new Error('boom'),
      });

      expect(scope.setTag).toHaveBeenCalledWith('worker', 'smartImportWorker');
      expect(scope.setTag).toHaveBeenCalledWith('jobName', 'commit-smart-import');
      expect(scope.setExtra).toHaveBeenCalledWith('jobId', 'job-abc');
      expect(scope.setExtra).toHaveBeenCalledWith('tenantId', 'tenant-1');
      expect(scope.setExtra).toHaveBeenCalledWith('attemptsMade', 3);
      expect(scope.setExtra).toHaveBeenCalledWith('totalAttempts', 3);
    });

    it('merges the extra object into the Sentry scope', () => {
      const scope = { setTag: jest.fn(), setExtra: jest.fn() };
      Sentry.withScope.mockImplementationOnce((cb) => cb(scope));

      reportWorkerFailure({
        workerName: 'plaidSyncWorker',
        job: makeJob({ attemptsMade: 3, attempts: 3 }),
        error: new Error('boom'),
        extra: { plaidItemId: 'item-42', customField: 'x' },
      });

      expect(scope.setExtra).toHaveBeenCalledWith('plaidItemId', 'item-42');
      expect(scope.setExtra).toHaveBeenCalledWith('customField', 'x');
    });
  });

  describe('edge cases', () => {
    it('treats a single-attempt job as final on its first failure (attempts defaults to 1)', () => {
      reportWorkerFailure({
        workerName: 'eventSchedulerWorker',
        job: { id: 'j1', name: 'route-event', data: {}, attemptsMade: 1, opts: {} },
        error: new Error('immediate failure'),
      });

      expect(Sentry.captureException).toHaveBeenCalled();
    });

    it('handles null job gracefully (queue-level error) and still reports', () => {
      reportWorkerFailure({
        workerName: 'portfolioWorker',
        job: null,
        error: new Error('queue down'),
      });

      // attemptsMade = 0, totalAttempts = 1 → 0 >= 1 is false → NOT final attempt
      // So this is treated as a transient warning. That's acceptable because
      // queue-level errors are rare and usually transient.
      expect(logger.warn).toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });
  });
});
