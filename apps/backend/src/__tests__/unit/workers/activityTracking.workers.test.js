// ─── activityTracking.workers.test.js ───────────────────────────────────────
// AC10 (#100): for every instrumented worker, a processing-status tracker
// whose Redis throws (synchronously or by rejecting) never escapes into the
// worker. Each worker is started against a mocked BullMQ that records its
// event listeners; every lifecycle event a job can produce is then fired with
// a tenant job and must return normally, logging at `warn` only.
//
// Also guards that each worker is wired exactly once and that its own
// `failed` handler (reportWorkerFailure) still runs alongside the tracker.

const { EventEmitter } = require('events');

const workerInstances = [];
jest.mock('bullmq', () => {
  const { EventEmitter: Emitter } = require('events');
  class Worker extends Emitter {
    constructor(name, processor) {
      super();
      this.name = name;
      this.processor = processor;
      this.close = jest.fn();
      workerInstances.push(this);
    }
  }
  class Queue extends Emitter {
    constructor(name) {
      super();
      this.name = name;
      this.add = jest.fn().mockResolvedValue({ id: 'cron' });
    }
  }
  return { Worker, Queue };
});

jest.mock('../../../utils/redis', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../../../prisma/prisma', () => ({}), { virtual: false });
jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/workerFailureReporter', () => {
  const actual = jest.requireActual('../../../utils/workerFailureReporter');
  return { ...actual, reportWorkerFailure: jest.fn() };
});

const logger = require('../../../utils/logger');
const { reportWorkerFailure } = require('../../../utils/workerFailureReporter');
const tracker = require('../../../utils/activityTracker');

const WORKERS = [
  ['portfolioWorker', 'startPortfolioWorker', 'portfolio', 'value-all-assets'],
  ['eventSchedulerWorker', 'startEventSchedulerWorker', 'events', 'MANUAL_TRANSACTION_MODIFIED'],
  ['analyticsWorker', 'startAnalyticsWorker', 'analytics', 'scoped-update-analytics'],
  ['plaidSyncWorker', 'startPlaidSyncWorker', 'plaid-sync', 'plaid-sync-job'],
  ['plaidProcessorWorker', 'startPlaidProcessorWorker', 'plaid-processing', 'PLAID_SYNC_COMPLETE'],
  ['smartImportWorker', 'startSmartImportWorker', 'smart-import', 'commit-smart-import'],
  ['insightGeneratorWorker', 'startInsightGeneratorWorker', 'insights', 'generate-tenant-insights'],
  ['securityMasterWorker', 'startSecurityMasterWorker', 'security-master', 'refresh-tenant-securities'],
  ['subscriptionDetectionWorker', 'startSubscriptionDetectionWorker', 'subscription-detection', 'detect-tenant'],
];

function throwingClient(mode) {
  const client = {};
  client.defineCommand = (name) => {
    client[name] = () => {
      if (mode === 'sync') throw new Error('READONLY You can\'t write against a read only replica');
      return Promise.reject(new Error('Connection is closed.'));
    };
  };
  return client;
}

const job = (name, attemptsMade = 3) => ({
  id: `${name}-1`,
  name,
  data: { tenantId: 'tenant-1', plaidItemId: 'pi-1' },
  timestamp: Date.now(),
  attemptsMade,
  opts: { attempts: 3 },
});

afterAll(() => tracker.__setClientForTests(null));

describe.each(WORKERS)('%s', (file, startFn, queueName, jobName) => {
  let worker;

  beforeAll(() => {
    const mod = require(`../../../workers/${file}`);
    workerInstances.length = 0;
    mod[startFn]();
    worker = workerInstances.find((w) => w.name === queueName);
  });

  beforeEach(() => jest.clearAllMocks());

  it('is wired to the tracker exactly once', () => {
    expect(worker).toBeDefined();
    expect(worker.listenerCount('active')).toBe(1);
    // smartImportWorker also logs progress itself.
    expect(worker.listenerCount('progress')).toBe(queueName === 'smart-import' ? 2 : 1);
    expect(worker.listenerCount('failed')).toBe(2); // reportWorkerFailure + tracker
  });

  it.each(['sync', 'async'])('survives a tracker Redis that throws (%s) on every lifecycle event', async (mode) => {
    tracker.__setClientForTests(throwingClient(mode));
    const j = job(jobName);

    expect(() => {
      worker.emit('active', j);
      worker.emit('progress', j, 40);
      worker.emit('progress', j, 100);
      worker.emit('failed', job(jobName, 1), new Error('transient'));
      worker.emit('failed', j, new Error('final'));
    }).not.toThrow();
    // `completed` listeners may be async (rebuild-lock release); only the
    // tracker's synchronous part matters here.
    expect(() => worker.listeners('completed').forEach((l) => {
      const out = l(j, {});
      if (out && typeof out.catch === 'function') out.catch(() => {});
    })).not.toThrow();

    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalled();
    // The worker's own failure reporting is untouched by the tracker.
    expect(reportWorkerFailure).toHaveBeenCalledTimes(2);
  });
});

describe('queue factories', () => {
  it.each([
    ['portfolioQueue', 'getPortfolioQueue'],
    ['eventsQueue', 'getEventsQueue'],
    ['analyticsQueue', 'getAnalyticsQueue'],
    ['plaidSyncQueue', 'getPlaidSyncQueue'],
    ['plaidProcessingQueue', 'getPlaidProcessingQueue'],
    ['smartImportQueue', 'getSmartImportQueue'],
    ['insightQueue', 'getInsightQueue'],
    ['securityMasterQueue', 'getSecurityMasterQueue'],
    ['subscriptionDetectionQueue', 'getSubscriptionDetectionQueue'],
  ])('%s is tracked once and survives a throwing tracker', (file, getter) => {
    tracker.__setClientForTests(throwingClient('sync'));
    const queue = require(`../../../queues/${file}`)[getter]();
    expect(queue).toBeInstanceOf(EventEmitter);
    expect(queue.listenerCount('waiting')).toBe(1);
    expect(() => queue.emit('waiting', job('process-cash-holdings'))).not.toThrow();
  });
});
