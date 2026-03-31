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

  // ─── Unknown event ───────────────────────────────────────────────────────

  it('warns for unknown event type', async () => {
    const job = makeJob('UNKNOWN_EVENT', { tenantId: 't1' });

    await processEventJob(job);

    expect(logger.warn).toHaveBeenCalledWith('Unknown event job name: UNKNOWN_EVENT');
  });
});
