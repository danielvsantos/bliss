/**
 * Unit tests for plaidSyncWorker.
 *
 * Tests the incremental sync (transactions/sync) and historical backfill
 * (transactions/get) paths, cursor management, and error handling.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('../../../queues/plaidProcessingQueue', () => ({
  getPlaidProcessingQueue: jest.fn().mockReturnValue({
    add: jest.fn().mockResolvedValue({}),
  }),
}));

let workerCallback;
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_queue, callback) => {
    workerCallback = callback;
    return { on: jest.fn(), close: jest.fn() };
  }),
}));

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn() })),
  captureException: jest.fn(),
}));

const mockTransactionsSync = jest.fn();
const mockTransactionsGet = jest.fn();
jest.mock('../../../services/plaid', () => ({
  plaidClient: {
    transactionsSync: (...args) => mockTransactionsSync(...args),
    transactionsGet: (...args) => mockTransactionsGet(...args),
  },
}));

jest.mock('../../../utils/encryption', () => ({
  encrypt: jest.fn((val) => `encrypted:${val}`),
}));

const mockPlaidItemFindUnique = jest.fn();
const mockPlaidItemUpdate = jest.fn();
const mockPlaidTransactionCreateMany = jest.fn();
const mockPlaidTransactionFindUnique = jest.fn();
const mockPlaidTransactionUpdate = jest.fn();
const mockPlaidTransactionCreate = jest.fn();
const mockPlaidSyncLogCreate = jest.fn();
const mockAccountFindMany = jest.fn();
jest.mock('../../../../prisma/prisma', () => ({
  account: {
    findMany: (...args) => mockAccountFindMany(...args),
  },
  plaidItem: {
    findUnique: (...args) => mockPlaidItemFindUnique(...args),
    update: (...args) => mockPlaidItemUpdate(...args),
  },
  plaidTransaction: {
    createMany: (...args) => mockPlaidTransactionCreateMany(...args),
    findUnique: (...args) => mockPlaidTransactionFindUnique(...args),
    update: (...args) => mockPlaidTransactionUpdate(...args),
    create: (...args) => mockPlaidTransactionCreate(...args),
  },
  plaidSyncLog: {
    create: (...args) => mockPlaidSyncLogCreate(...args),
  },
}));

const mockEnableBankingDispatch = jest.fn();
const mockSyncConnection = jest.fn();
jest.mock('../../../workers/handlers/enableBankingSync', () => ({
  enableBankingDispatch: (...args) => mockEnableBankingDispatch(...args),
  syncConnection: (...args) => mockSyncConnection(...args),
}));

const mockEtoroDispatch = jest.fn();
jest.mock('../../../workers/handlers/etoroSync', () => ({
  etoroDispatch: (...args) => mockEtoroDispatch(...args),
}));

// ─── Import ─────────────────────────────────────────────────────────────────

const { getPlaidProcessingQueue } = require('../../../queues/plaidProcessingQueue');
const { startPlaidSyncWorker } = require('../../../workers/plaidSyncWorker');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeJob(name, data = {}) {
  return { id: `test-job-${name}`, name, data };
}

const PLAID_ITEM = {
  id: 'pi-1',
  accessToken: 'access-sandbox-123',
  nextCursor: null,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01'),
  earliestTransactionDate: null,
  tenant: { plaidHistoryDays: 30 },
};

function makeSyncResponse({ added = [], modified = [], removed = [], hasMore = false, cursor = 'cursor-1' } = {}) {
  return {
    data: {
      added,
      modified,
      removed,
      next_cursor: cursor,
      has_more: hasMore,
    },
  };
}

function makePlaidTxn(overrides = {}) {
  return {
    transaction_id: 'txn-1',
    account_id: 'acc-1',
    amount: 25.00,
    date: '2026-02-15',
    authorized_date: null,
    name: 'Starbucks',
    merchant_name: 'Starbucks Coffee',
    payment_channel: 'in store',
    iso_currency_code: 'USD',
    pending: false,
    personal_finance_category: [],
    pending_transaction_id: null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('plaidSyncWorker', () => {
  beforeAll(() => {
    startPlaidSyncWorker();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlaidItemFindUnique.mockResolvedValue({ ...PLAID_ITEM });
    mockAccountFindMany.mockResolvedValue([{ plaidAccountId: 'acc-1' }]);
    mockPlaidItemUpdate.mockResolvedValue({});
    mockPlaidTransactionCreateMany.mockResolvedValue({ count: 0 });
    mockPlaidSyncLogCreate.mockResolvedValue({});
  });

  it('throws when plaidItemId is missing', async () => {
    await expect(
      workerCallback(makeJob('PLAID_INITIAL_SYNC', {}))
    ).rejects.toThrow('plaidItemId is required');
  });

  it('skips sync for non-ACTIVE plaid items', async () => {
    mockPlaidItemFindUnique.mockResolvedValue({ ...PLAID_ITEM, status: 'REVOKED' });

    await workerCallback(makeJob('PLAID_INITIAL_SYNC', { plaidItemId: 'pi-1' }));

    expect(mockTransactionsSync).not.toHaveBeenCalled();
    expect(mockTransactionsGet).not.toHaveBeenCalled();
  });

  describe('incremental sync (transactions/sync)', () => {
    it('fetches transactions and creates PlaidTransaction records', async () => {
      const txn = makePlaidTxn();
      mockTransactionsSync.mockResolvedValue(makeSyncResponse({ added: [txn], cursor: 'cursor-2' }));
      mockPlaidTransactionCreateMany.mockResolvedValue({ count: 1 });

      await workerCallback(makeJob('PLAID_INITIAL_SYNC', { plaidItemId: 'pi-1' }));

      expect(mockTransactionsSync).toHaveBeenCalledWith(expect.objectContaining({
        access_token: 'access-sandbox-123',
        count: 500,
      }));
      expect(mockPlaidTransactionCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([expect.objectContaining({
            plaidTransactionId: 'txn-1',
            name: 'Starbucks',
          })]),
          skipDuplicates: true,
        })
      );
    });

    it('updates sync cursor after each page', async () => {
      mockTransactionsSync.mockResolvedValue(makeSyncResponse({ cursor: 'new-cursor' }));

      await workerCallback(makeJob('PLAID_INITIAL_SYNC', { plaidItemId: 'pi-1' }));

      expect(mockPlaidItemUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pi-1' },
          data: expect.objectContaining({ nextCursor: 'new-cursor' }),
        })
      );
    });

    it('dispatches processor job after sync completes', async () => {
      mockTransactionsSync.mockResolvedValue(makeSyncResponse());

      await workerCallback(makeJob('PLAID_INITIAL_SYNC', { plaidItemId: 'pi-1' }));

      const processingQueue = getPlaidProcessingQueue();
      expect(processingQueue.add).toHaveBeenCalledWith(
        'PLAID_SYNC_COMPLETE',
        expect.objectContaining({ plaidItemId: 'pi-1' })
      );
    });

    it('handles modified transactions by updating existing records', async () => {
      const modTxn = makePlaidTxn({ transaction_id: 'txn-mod', amount: 30 });
      mockTransactionsSync.mockResolvedValue(makeSyncResponse({ modified: [modTxn] }));
      mockPlaidTransactionFindUnique.mockResolvedValue({ id: 42 });
      mockPlaidTransactionUpdate.mockResolvedValue({});

      await workerCallback(makeJob('PLAID_SYNC_UPDATES', { plaidItemId: 'pi-1' }));

      expect(mockPlaidTransactionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 42 },
          data: expect.objectContaining({ amount: 30, syncType: 'MODIFIED', processed: false }),
        })
      );
    });

    it('handles Plaid API errors and updates item status', async () => {
      const plaidError = new Error('ITEM_LOGIN_REQUIRED');
      plaidError.response = { data: { error_code: 'ITEM_LOGIN_REQUIRED' } };
      mockTransactionsSync.mockRejectedValue(plaidError);
      mockPlaidSyncLogCreate.mockResolvedValue({});

      await expect(
        workerCallback(makeJob('PLAID_INITIAL_SYNC', { plaidItemId: 'pi-1' }))
      ).rejects.toThrow();

      expect(mockPlaidItemUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'LOGIN_REQUIRED', errorCode: 'ITEM_LOGIN_REQUIRED' }),
        })
      );
    });
  });

  describe('eToro copy trading (#143)', () => {
    it('dispatches ETORO_* jobs to the eToro handler without touching Plaid', async () => {
      mockEtoroDispatch.mockResolvedValue({ status: 'SUCCESS' });
      const job = makeJob('ETORO_SYNC', { connectionId: 'c-1', tenantId: 't-1' });
      await expect(workerCallback(job)).resolves.toEqual({ status: 'SUCCESS' });
      expect(mockEtoroDispatch).toHaveBeenCalledWith(job);
      expect(mockTransactionsSync).not.toHaveBeenCalled();
      expect(mockPlaidItemFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('Enable Banking (#132)', () => {
    it('dispatches ENABLE_BANKING_* jobs to the Enable Banking handler without touching Plaid', async () => {
      mockEnableBankingDispatch.mockResolvedValue({ status: 'SUCCESS' });
      const job = makeJob('ENABLE_BANKING_SYNC', { plaidItemId: 'eb-1' });
      await expect(workerCallback(job)).resolves.toEqual({ status: 'SUCCESS' });
      expect(mockEnableBankingDispatch).toHaveBeenCalledWith(job);
      expect(mockTransactionsSync).not.toHaveBeenCalled();
      expect(mockPlaidItemFindUnique).not.toHaveBeenCalled();
    });

    it('routes a generic Plaid sync of an Enable Banking item to the Enable Banking sync', async () => {
      mockPlaidItemFindUnique.mockResolvedValue({ ...PLAID_ITEM, provider: 'ENABLE_BANKING' });
      mockSyncConnection.mockResolvedValue({ status: 'SUCCESS' });
      const job = makeJob('plaid-sync-job', { plaidItemId: 'pi-1', source: 'MANUAL_RESYNC' });
      await workerCallback(job);
      expect(mockSyncConnection).toHaveBeenCalledWith(job);
      expect(mockTransactionsSync).not.toHaveBeenCalled();
    });

    it('drops added transactions for accounts no longer linked to the item (provider switch)', async () => {
      mockAccountFindMany.mockResolvedValue([{ plaidAccountId: 'acc-1' }]);
      mockTransactionsSync.mockResolvedValueOnce(makeSyncResponse({
        added: [
          makePlaidTxn({ transaction_id: 'keep', account_id: 'acc-1' }),
          makePlaidTxn({ transaction_id: 'drop', account_id: 'acc-switched' }),
        ],
      }));
      await workerCallback(makeJob('PLAID_SYNC_UPDATES', { plaidItemId: 'pi-1' }));
      const inserted = mockPlaidTransactionCreateMany.mock.calls[0][0].data;
      expect(inserted.map(r => r.plaidTransactionId)).toEqual(['keep']);
    });
  });

  describe('historical backfill (transactions/get)', () => {
    it('fetches historical transactions in batches', async () => {
      const txn = makePlaidTxn({ date: '2025-06-01' });
      mockTransactionsGet.mockResolvedValue({
        data: { transactions: [txn], total_transactions: 1 },
      });
      mockPlaidTransactionCreateMany.mockResolvedValue({ count: 1 });

      await workerCallback(makeJob('PLAID_HISTORICAL_BACKFILL', {
        plaidItemId: 'pi-1',
        source: 'HISTORICAL_BACKFILL',
        fromDate: '2025-01-01',
      }));

      expect(mockTransactionsGet).toHaveBeenCalledWith(expect.objectContaining({
        access_token: 'access-sandbox-123',
        start_date: '2025-01-01',
        options: expect.objectContaining({ count: 500, offset: 0 }),
      }));
      expect(mockPlaidTransactionCreateMany).toHaveBeenCalled();
    });
  });
});
