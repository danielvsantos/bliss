// Mock all queue modules and dependencies before requiring the worker
jest.mock('../../../queues/eventsQueue', () => ({
  getEventsQueue: jest.fn(),
  EVENTS_QUEUE_NAME: 'test-events',
  enqueueEvent: jest.fn(),
}));

jest.mock('../../../queues/portfolioQueue', () => ({
  getPortfolioQueue: jest.fn(),
}));

jest.mock('../../../queues/analyticsQueue', () => ({
  getAnalyticsQueue: jest.fn(),
}));

jest.mock('../../../queues/plaidSyncQueue', () => ({
  getPlaidSyncQueue: jest.fn(),
}));

jest.mock('../../../queues/smartImportQueue', () => ({
  getSmartImportQueue: jest.fn(),
}));

jest.mock('../../../services/debounceService', () => ({
  scheduleDebouncedJob: jest.fn(),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Prevent BullMQ Worker from starting
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
}));

const { getPortfolioQueue } = require('../../../queues/portfolioQueue');
const { getAnalyticsQueue } = require('../../../queues/analyticsQueue');
const { getPlaidSyncQueue } = require('../../../queues/plaidSyncQueue');
const { getSmartImportQueue } = require('../../../queues/smartImportQueue');
const { scheduleDebouncedJob } = require('../../../services/debounceService');
const logger = require('../../../utils/logger');

const { processEventJob } = require('../../../workers/eventSchedulerWorker');

// ─── Mock queue instances ─────────────────────────────────────────────────────

const mockPortfolioQueue = { add: jest.fn().mockResolvedValue({ id: 'p-1' }) };
const mockAnalyticsQueue = { add: jest.fn().mockResolvedValue({ id: 'a-1' }) };
const mockPlaidSyncQueue = { add: jest.fn().mockResolvedValue({ id: 'ps-1' }) };
const mockSmartImportQueue = { add: jest.fn().mockResolvedValue({ id: 'si-1' }) };

getPortfolioQueue.mockReturnValue(mockPortfolioQueue);
getAnalyticsQueue.mockReturnValue(mockAnalyticsQueue);
getPlaidSyncQueue.mockReturnValue(mockPlaidSyncQueue);
getSmartImportQueue.mockReturnValue(mockSmartImportQueue);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(name, data = {}) {
  return { id: `test-job-${name}`, name, data };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('eventSchedulerWorker — processEventJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPortfolioQueue.mockReturnValue(mockPortfolioQueue);
    getAnalyticsQueue.mockReturnValue(mockAnalyticsQueue);
    getPlaidSyncQueue.mockReturnValue(mockPlaidSyncQueue);
    getSmartImportQueue.mockReturnValue(mockSmartImportQueue);
  });

  // ─── SMART_IMPORT_REQUESTED ──────────────────────────────────────────────

  it('enqueues smart-import job for SMART_IMPORT_REQUESTED', async () => {
    const job = makeJob('SMART_IMPORT_REQUESTED', {
      tenantId: 't1',
      userId: 'u1',
      accountId: 'a1',
      adapterId: 'ad1',
      fileStorageKey: 'file.csv',
      stagedImportId: 'si1',
    });

    await processEventJob(job);

    expect(mockSmartImportQueue.add).toHaveBeenCalledWith(
      'process-smart-import',
      expect.objectContaining({
        tenantId: 't1',
        userId: 'u1',
        fileStorageKey: 'file.csv',
        stagedImportId: 'si1',
      }),
      expect.objectContaining({ jobId: expect.any(String) })
    );
  });

  it('warns and returns for SMART_IMPORT_REQUESTED with missing data', async () => {
    const job = makeJob('SMART_IMPORT_REQUESTED', { tenantId: 't1' });

    await processEventJob(job);

    expect(logger.warn).toHaveBeenCalledWith(
      'SMART_IMPORT_REQUESTED event is missing required data.'
    );
    expect(mockSmartImportQueue.add).not.toHaveBeenCalled();
  });

  // ─── SMART_IMPORT_COMMIT ────────────────────────────────────────────────

  it('enqueues commit-smart-import job for SMART_IMPORT_COMMIT', async () => {
    const job = makeJob('SMART_IMPORT_COMMIT', {
      tenantId: 't1',
      userId: 'u1',
      stagedImportId: 'si1',
      rowIds: null,
    });

    await processEventJob(job);

    expect(mockSmartImportQueue.add).toHaveBeenCalledWith(
      'commit-smart-import',
      expect.objectContaining({
        tenantId: 't1',
        userId: 'u1',
        stagedImportId: 'si1',
        rowIds: null,
      }),
      expect.objectContaining({ jobId: expect.any(String) })
    );
  });

  it('warns and returns for SMART_IMPORT_COMMIT with missing data', async () => {
    const job = makeJob('SMART_IMPORT_COMMIT', { tenantId: 't1' });

    await processEventJob(job);

    expect(logger.warn).toHaveBeenCalledWith(
      'SMART_IMPORT_COMMIT event is missing required data.'
    );
    expect(mockSmartImportQueue.add).not.toHaveBeenCalled();
  });

  // ─── PLAID_INITIAL_SYNC / PLAID_SYNC_UPDATES ────────────────────────────

  it('enqueues plaid-sync job for PLAID_INITIAL_SYNC', async () => {
    const job = makeJob('PLAID_INITIAL_SYNC', {
      plaidItemId: 'pi1',
      tenantId: 't1',
      source: 'INITIAL',
    });

    await processEventJob(job);

    expect(mockPlaidSyncQueue.add).toHaveBeenCalledWith(
      'plaid-sync-job',
      { plaidItemId: 'pi1', tenantId: 't1', source: 'INITIAL' }
    );
  });

  it('warns for PLAID_INITIAL_SYNC without plaidItemId', async () => {
    const job = makeJob('PLAID_INITIAL_SYNC', { tenantId: 't1' });

    await processEventJob(job);

    expect(logger.warn).toHaveBeenCalled();
    expect(mockPlaidSyncQueue.add).not.toHaveBeenCalled();
  });

  // ─── PLAID_HISTORICAL_BACKFILL ──────────────────────────────────────────

  it('enqueues plaid-sync job for PLAID_HISTORICAL_BACKFILL with fromDate', async () => {
    const job = makeJob('PLAID_HISTORICAL_BACKFILL', {
      plaidItemId: 'pi1',
      tenantId: 't1',
      fromDate: '2024-06-01',
    });

    await processEventJob(job);

    expect(mockPlaidSyncQueue.add).toHaveBeenCalledWith(
      'plaid-sync-job',
      { plaidItemId: 'pi1', tenantId: 't1', source: 'HISTORICAL_BACKFILL', fromDate: '2024-06-01' }
    );
  });

  it('warns for PLAID_HISTORICAL_BACKFILL without plaidItemId', async () => {
    const job = makeJob('PLAID_HISTORICAL_BACKFILL', { tenantId: 't1', fromDate: '2024-06-01' });

    await processEventJob(job);

    expect(logger.warn).toHaveBeenCalledWith(
      'PLAID_HISTORICAL_BACKFILL event is missing required data.'
    );
    expect(mockPlaidSyncQueue.add).not.toHaveBeenCalled();
  });

  it('warns for PLAID_HISTORICAL_BACKFILL without fromDate', async () => {
    const job = makeJob('PLAID_HISTORICAL_BACKFILL', { plaidItemId: 'pi1', tenantId: 't1' });

    await processEventJob(job);

    expect(logger.warn).toHaveBeenCalledWith(
      'PLAID_HISTORICAL_BACKFILL event is missing required data.'
    );
    expect(mockPlaidSyncQueue.add).not.toHaveBeenCalled();
  });

  // ─── TRANSACTIONS_IMPORTED ───────────────────────────────────────────────

  it('uses debounce for TRANSACTIONS_IMPORTED', async () => {
    const job = makeJob('TRANSACTIONS_IMPORTED', {
      tenantId: 't1',
      accountIds: [1, 2],
      dateScopes: [{ year: 2026, month: 3 }],
    });

    await processEventJob(job);

    expect(scheduleDebouncedJob).toHaveBeenCalledWith(
      mockPortfolioQueue,
      'process-portfolio-changes',
      expect.objectContaining({ tenantId: 't1', needsSync: [true] }),
      'needsSync',
      10 // DEBOUNCE_DELAY_SECONDS * 2
    );
  });

  // ─── MANUAL_TRANSACTION_MODIFIED ─────────────────────────────────────────

  it('routes Investment-type transaction to portfolio processor', async () => {
    const job = makeJob('MANUAL_TRANSACTION_MODIFIED', {
      tenantId: 't1',
      transactionId: 'tx1',
      categoryType: 'Investments',
      transaction_date: '2026-03-01',
    });

    await processEventJob(job);

    expect(mockPortfolioQueue.add).toHaveBeenCalledWith(
      'process-portfolio-changes',
      { tenantId: 't1', transactionId: 'tx1' }
    );
  });

  it('routes simple transaction to cash processor', async () => {
    const job = makeJob('MANUAL_TRANSACTION_CREATED', {
      tenantId: 't1',
      transactionId: 'tx1',
      categoryType: 'Essentials',
      transaction_date: '2026-03-01',
      currency: 'USD',
      country: 'US',
      categoryGroup: 'Food',
    });

    await processEventJob(job);

    expect(scheduleDebouncedJob).toHaveBeenCalledWith(
      mockPortfolioQueue,
      'process-cash-holdings',
      expect.objectContaining({ tenantId: 't1' }),
      'needsCashRebuild',
      expect.any(Number)
    );
  });

  // ─── TAG_ASSIGNMENT_MODIFIED ────────────────────────────────────────────

  it('routes TAG_ASSIGNMENT_MODIFIED to analytics queue via debounce', async () => {
    const job = makeJob('TAG_ASSIGNMENT_MODIFIED', {
      tenantId: 't1',
      transactionScopes: [{ year: 2026, month: 3, currency: 'USD', country: 'US' }],
    });

    await processEventJob(job);

    expect(scheduleDebouncedJob).toHaveBeenCalledWith(
      mockAnalyticsQueue,
      'scoped-update-analytics',
      { tenantId: 't1', scopes: [{ year: 2026, month: 3, currency: 'USD', country: 'US' }] },
      'scopes',
      5 // DEBOUNCE_DELAY_SECONDS
    );
  });

  it('uses empty scopes array when transactionScopes is missing', async () => {
    const job = makeJob('TAG_ASSIGNMENT_MODIFIED', {
      tenantId: 't1',
    });

    await processEventJob(job);

    expect(scheduleDebouncedJob).toHaveBeenCalledWith(
      mockAnalyticsQueue,
      'scoped-update-analytics',
      { tenantId: 't1', scopes: [] },
      'scopes',
      5
    );
  });

  it('warns when TAG_ASSIGNMENT_MODIFIED is missing tenantId', async () => {
    const job = makeJob('TAG_ASSIGNMENT_MODIFIED', {
      transactionScopes: [{ year: 2026, month: 3 }],
    });

    await processEventJob(job);

    expect(logger.warn).toHaveBeenCalledWith(
      'TAG_ASSIGNMENT_MODIFIED event is missing tenantId.'
    );
    expect(scheduleDebouncedJob).not.toHaveBeenCalled();
  });

  // ─── MANUAL_REBUILD_REQUESTED ────────────────────────────────────────────
  //
  // Admin-triggered rebuilds from the Maintenance UI. One event type with
  // a `scope` discriminator covers four distinct routing paths. Each path
  // is tested for:
  //   - correct queue + job name selection
  //   - `_rebuildMeta` attached so the job shows up in rebuild history
  //   - 30-day `removeOnComplete` + `removeOnFail` retention
  //   - deterministic `jobId` that includes the scope + tenant

  describe('MANUAL_REBUILD_REQUESTED', () => {
    it('warns when tenantId is missing', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', { scope: 'full-analytics' });
      await processEventJob(job);
      expect(logger.warn).toHaveBeenCalledWith(
        'MANUAL_REBUILD_REQUESTED event is missing tenantId or scope.'
      );
    });

    it('warns when scope is missing', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', { tenantId: 't1' });
      await processEventJob(job);
      expect(logger.warn).toHaveBeenCalledWith(
        'MANUAL_REBUILD_REQUESTED event is missing tenantId or scope.'
      );
    });

    it('warns for unknown scope', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', { tenantId: 't1', scope: 'garbage' });
      await processEventJob(job);
      expect(logger.warn).toHaveBeenCalledWith('Unknown MANUAL_REBUILD_REQUESTED scope: garbage');
    });

    it('routes full-portfolio → process-portfolio-changes with 30-day retention', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', {
        tenantId: 't1',
        scope: 'full-portfolio',
        requestedBy: 'alice@example.com',
        requestedAt: '2026-04-23T10:00:00.000Z',
      });
      await processEventJob(job);

      expect(mockPortfolioQueue.add).toHaveBeenCalledWith(
        'process-portfolio-changes',
        expect.objectContaining({
          tenantId: 't1',
          _rebuildMeta: {
            requestedBy: 'alice@example.com',
            requestedAt: '2026-04-23T10:00:00.000Z',
            rebuildType: 'full-portfolio',
          },
        }),
        expect.objectContaining({
          jobId: expect.stringMatching(/^manual-rebuild-full-portfolio-t1-/),
          removeOnComplete: { age: 30 * 24 * 3600 },
          removeOnFail: { age: 30 * 24 * 3600 },
        })
      );
    });

    it('routes full-analytics → full-rebuild-analytics (analytics queue, no portfolio touch)', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', {
        tenantId: 't1',
        scope: 'full-analytics',
      });
      await processEventJob(job);

      expect(mockAnalyticsQueue.add).toHaveBeenCalledWith(
        'full-rebuild-analytics',
        expect.objectContaining({
          tenantId: 't1',
          _rebuildMeta: expect.objectContaining({ rebuildType: 'full-analytics' }),
        }),
        expect.objectContaining({
          jobId: expect.stringMatching(/^manual-rebuild-full-analytics-t1-/),
        })
      );
      expect(mockPortfolioQueue.add).not.toHaveBeenCalled();
    });

    it('routes scoped-analytics → scoped-update-analytics with earliestDate', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', {
        tenantId: 't1',
        scope: 'scoped-analytics',
        payload: { earliestDate: '2026-03-01T00:00:00.000Z' },
      });
      await processEventJob(job);

      expect(mockAnalyticsQueue.add).toHaveBeenCalledWith(
        'scoped-update-analytics',
        expect.objectContaining({
          tenantId: 't1',
          scopes: [{ earliestDate: '2026-03-01T00:00:00.000Z' }],
          _rebuildMeta: expect.objectContaining({ rebuildType: 'scoped-analytics' }),
        }),
        expect.any(Object)
      );
    });

    it('warns when scoped-analytics is missing earliestDate', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', {
        tenantId: 't1',
        scope: 'scoped-analytics',
        payload: {},
      });
      await processEventJob(job);

      expect(logger.warn).toHaveBeenCalledWith(
        'MANUAL_REBUILD_REQUESTED (scoped-analytics) missing payload.earliestDate.'
      );
      expect(mockAnalyticsQueue.add).not.toHaveBeenCalled();
    });

    it('routes single-asset → value-portfolio-items with portfolioItemIds', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', {
        tenantId: 't1',
        scope: 'single-asset',
        payload: { portfolioItemId: 42 },
      });
      await processEventJob(job);

      expect(mockPortfolioQueue.add).toHaveBeenCalledWith(
        'value-portfolio-items',
        expect.objectContaining({
          tenantId: 't1',
          portfolioItemIds: [42],
          _rebuildMeta: expect.objectContaining({ rebuildType: 'single-asset' }),
        }),
        expect.any(Object)
      );
    });

    it('warns when single-asset is missing portfolioItemId', async () => {
      const job = makeJob('MANUAL_REBUILD_REQUESTED', {
        tenantId: 't1',
        scope: 'single-asset',
        payload: {},
      });
      await processEventJob(job);

      expect(logger.warn).toHaveBeenCalledWith(
        'MANUAL_REBUILD_REQUESTED (single-asset) missing payload.portfolioItemId.'
      );
      expect(mockPortfolioQueue.add).not.toHaveBeenCalled();
    });
  });

  // ─── _rebuildMeta propagation through the full-portfolio chain ───────────
  //
  // The single-flight lock is released by the terminal job's completion
  // handler (`utils/rebuildLock.js`). For the full-portfolio chain
  // process-portfolio-changes → cash → analytics → value-all-assets,
  // `_rebuildMeta` starts on the initial job and must ride through each
  // downstream event → job hop to reach `value-all-assets`. If any
  // propagation link breaks, the lock will never release and the admin
  // will be stuck until the TTL expires.

  describe('_rebuildMeta propagation (full-portfolio chain)', () => {
    const meta = { rebuildType: 'full-portfolio', requestedBy: 'admin@example.com', requestedAt: '2026-04-23T10:00:00.000Z' };

    it('PORTFOLIO_CHANGES_PROCESSED forwards _rebuildMeta to process-cash-holdings (full rebuild)', async () => {
      const job = makeJob('PORTFOLIO_CHANGES_PROCESSED', {
        tenantId: 't1',
        isFullRebuild: true,
        _rebuildMeta: meta,
      });
      await processEventJob(job);

      expect(scheduleDebouncedJob).toHaveBeenCalledWith(
        mockPortfolioQueue,
        'process-cash-holdings',
        expect.objectContaining({ tenantId: 't1', _rebuildMeta: meta }),
        'needsCashRebuild',
        expect.any(Number),
      );
    });

    it('PORTFOLIO_CHANGES_PROCESSED forwards _rebuildMeta on scoped path too', async () => {
      const job = makeJob('PORTFOLIO_CHANGES_PROCESSED', {
        tenantId: 't1',
        isFullRebuild: false,
        dateScopes: [{ year: 2026, month: 3 }],
        _rebuildMeta: meta,
      });
      await processEventJob(job);

      expect(scheduleDebouncedJob).toHaveBeenCalledWith(
        mockPortfolioQueue,
        'process-cash-holdings',
        expect.objectContaining({ _rebuildMeta: meta }),
        'needsCashRebuild',
        expect.any(Number),
      );
    });

    it('CASH_HOLDINGS_PROCESSED forwards _rebuildMeta to full-rebuild-analytics', async () => {
      const job = makeJob('CASH_HOLDINGS_PROCESSED', {
        tenantId: 't1',
        isFullRebuild: true,
        _rebuildMeta: meta,
      });
      await processEventJob(job);

      expect(scheduleDebouncedJob).toHaveBeenCalledWith(
        mockAnalyticsQueue,
        'full-rebuild-analytics',
        expect.objectContaining({ _rebuildMeta: meta }),
        'needsRecalc',
        expect.any(Number),
      );
    });

    it('ANALYTICS_RECALCULATION_COMPLETE forwards _rebuildMeta to value-all-assets', async () => {
      const job = makeJob('ANALYTICS_RECALCULATION_COMPLETE', {
        tenantId: 't1',
        isFullRebuild: true,
        _rebuildMeta: meta,
      });
      await processEventJob(job);

      expect(mockPortfolioQueue.add).toHaveBeenCalledWith(
        'value-all-assets',
        expect.objectContaining({ tenantId: 't1', _rebuildMeta: meta }),
      );
    });

    it('events without _rebuildMeta do NOT propagate the field (no stale injection)', async () => {
      const job = makeJob('PORTFOLIO_CHANGES_PROCESSED', {
        tenantId: 't1',
        isFullRebuild: true,
      });
      await processEventJob(job);

      const call = scheduleDebouncedJob.mock.calls.find(
        (c) => c[1] === 'process-cash-holdings',
      );
      expect(call).toBeDefined();
      expect(call[2]).not.toHaveProperty('_rebuildMeta');
    });
  });

  // ─── ANALYTICS_RECALCULATION_COMPLETE cascade suppression ───────────────
  //
  // When a manual `full-analytics` rebuild finishes, the analyticsWorker
  // forwards `_rebuildMeta` in the completion event. The scheduler must
  // detect this marker and suppress the downstream valuation cascade —
  // otherwise the "analytics-only" button would still trigger a full
  // `value-all-assets` run, defeating the purpose.

  describe('ANALYTICS_RECALCULATION_COMPLETE — cascade suppression', () => {
    it('suppresses value-all-assets when _rebuildMeta.rebuildType === "full-analytics"', async () => {
      const job = makeJob('ANALYTICS_RECALCULATION_COMPLETE', {
        tenantId: 't1',
        isFullRebuild: true,
        _rebuildMeta: { rebuildType: 'full-analytics' },
      });
      await processEventJob(job);

      expect(mockPortfolioQueue.add).not.toHaveBeenCalled();
    });

    it('cascades into value-all-assets for normal isFullRebuild (no _rebuildMeta)', async () => {
      const job = makeJob('ANALYTICS_RECALCULATION_COMPLETE', {
        tenantId: 't1',
        isFullRebuild: true,
      });
      await processEventJob(job);

      expect(mockPortfolioQueue.add).toHaveBeenCalledWith('value-all-assets', { tenantId: 't1' });
      expect(mockPortfolioQueue.add).toHaveBeenCalledWith('process-amortizing-loan', { tenantId: 't1' });
      expect(mockPortfolioQueue.add).toHaveBeenCalledWith('process-simple-liability', { tenantId: 't1' });
    });

    it('still cascades for full-rebuild when _rebuildMeta indicates a different scope (full-portfolio)', async () => {
      // full-portfolio rebuilds intentionally want the cascade — the
      // suppression only targets the analytics-only button. The meta is
      // also forwarded onto the value-all-assets job so its completion
      // handler can release the single-flight lock.
      const job = makeJob('ANALYTICS_RECALCULATION_COMPLETE', {
        tenantId: 't1',
        isFullRebuild: true,
        _rebuildMeta: { rebuildType: 'full-portfolio' },
      });
      await processEventJob(job);

      expect(mockPortfolioQueue.add).toHaveBeenCalledWith('value-all-assets', {
        tenantId: 't1',
        _rebuildMeta: { rebuildType: 'full-portfolio' },
      });
    });

    it('scoped analytics with empty portfolioItemIds does not trigger valuation', async () => {
      const job = makeJob('ANALYTICS_RECALCULATION_COMPLETE', {
        tenantId: 't1',
        isFullRebuild: false,
        _rebuildMeta: { rebuildType: 'scoped-analytics' },
      });
      await processEventJob(job);

      expect(mockPortfolioQueue.add).not.toHaveBeenCalled();
    });
  });

  // ─── Unknown event ───────────────────────────────────────────────────────

  it('warns for unknown event type', async () => {
    const job = makeJob('UNKNOWN_EVENT', { tenantId: 't1' });

    await processEventJob(job);

    expect(logger.warn).toHaveBeenCalledWith('Unknown event job name: UNKNOWN_EVENT');
  });
});
