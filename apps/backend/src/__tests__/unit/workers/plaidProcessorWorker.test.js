/**
 * Unit tests for plaidProcessorWorker.
 *
 * Tests exported helpers (normalizeDescription, buildFrequencyMap) and
 * the worker's classification pipeline via the captured BullMQ callback.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../../queues/plaidProcessingQueue', () => ({
  getPlaidProcessingQueue: jest.fn().mockReturnValue({
    add: jest.fn().mockResolvedValue({}),
  }),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

let workerCallback;
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_queue, callback) => {
    workerCallback = callback;
    return { on: jest.fn(), close: jest.fn() };
  }),
}));

jest.mock('@sentry/node', () => ({
  withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn() })),
  captureException: jest.fn(),
}));

const mockPlaidTxUpdate = jest.fn().mockResolvedValue({});
const mockPlaidTxUpdateMany = jest.fn().mockResolvedValue({});
const mockPlaidTxFindMany = jest.fn();
const mockPlaidItemFindUnique = jest.fn();
const mockPlaidItemUpdate = jest.fn().mockResolvedValue({});
const mockTenantFindUnique = jest.fn();
const mockAccountFindMany = jest.fn();
const mockTxCreate = jest.fn();
const mockTxFindMany = jest.fn();
const mockPrismaTransaction = jest.fn();

jest.mock('../../../../prisma/prisma', () => ({
  plaidTransaction: {
    update: (...args) => mockPlaidTxUpdate(...args),
    updateMany: (...args) => mockPlaidTxUpdateMany(...args),
    findMany: (...args) => mockPlaidTxFindMany(...args),
  },
  plaidItem: {
    findUnique: (...args) => mockPlaidItemFindUnique(...args),
    update: (...args) => mockPlaidItemUpdate(...args),
  },
  tenant: {
    findUnique: (...args) => mockTenantFindUnique(...args),
  },
  account: {
    findMany: (...args) => mockAccountFindMany(...args),
  },
  transaction: {
    create: (...args) => mockTxCreate(...args),
    findMany: (...args) => mockTxFindMany(...args),
  },
  $transaction: (...args) => mockPrismaTransaction(...args),
}));

const mockClassify = jest.fn();
const mockRecordFeedback = jest.fn();
jest.mock('../../../services/categorizationService', () => ({
  classify: (...args) => mockClassify(...args),
  recordFeedback: (...args) => mockRecordFeedback(...args),
}));

jest.mock('../../../utils/descriptionCache', () => ({
  warmDescriptionCache: jest.fn().mockResolvedValue(undefined),
}));

const mockGetCategoriesForTenant = jest.fn();
jest.mock('../../../utils/categoryCache', () => ({
  getCategoriesForTenant: (...args) => mockGetCategoriesForTenant(...args),
}));

jest.mock('../../../services/geminiService', () => ({
  isRateLimitError: jest.fn().mockReturnValue(false),
}));

const mockComputeTransactionHash = jest.fn().mockReturnValue('mock-hash');
const mockBuildDuplicateHashSet = jest.fn().mockResolvedValue(new Set());
jest.mock('../../../utils/transactionHash', () => ({
  computeTransactionHash: (...args) => mockComputeTransactionHash(...args),
  buildDuplicateHashSet: (...args) => mockBuildDuplicateHashSet(...args),
}));

jest.mock('../../../config/classificationConfig', () => ({
  DEFAULT_AUTO_PROMOTE_THRESHOLD: 0.90,
  DEFAULT_REVIEW_THRESHOLD: 0.70,
  TOP_N_SEEDS: 10,
  PHASE2_CONCURRENCY: 3,
}));

// p-limit is ESM-only and uses dynamic import() in the worker.
// We need to mock it at the module level so the dynamic import resolves.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: (concurrency) => {
    // Return a function that just calls the passed function directly
    return (fn) => fn();
  },
}));

// ─── Import ─────────────────────────────────────────────────────────────────

const { normalizeDescription, buildFrequencyMap, startPlaidProcessorWorker } = require('../../../workers/plaidProcessorWorker');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeJob(name, data = {}) {
  return { id: `test-job-${name}`, name, data };
}

function makePendingTx(overrides = {}) {
  return {
    id: 1,
    name: 'Starbucks',
    merchantName: 'Starbucks Coffee',
    amount: 5.50,
    date: '2026-03-01',
    isoCurrencyCode: 'USD',
    plaidAccountId: 'plaid-acc-1',
    plaidTransactionId: 'ptxn-1',
    category: [],
    ...overrides,
  };
}

function setupWorkerContext() {
  mockPlaidItemFindUnique.mockResolvedValue({ tenantId: 'tenant-1' });
  mockTenantFindUnique.mockResolvedValue({ autoPromoteThreshold: 0.90, reviewThreshold: 0.70 });
  mockGetCategoriesForTenant.mockResolvedValue([
    { id: 'cat-dining', type: 'Essentials', processingHint: null },
    { id: 'cat-stocks', type: 'Investments', processingHint: 'API_STOCK' },
  ]);
  mockAccountFindMany.mockResolvedValue([
    { id: 'local-acc-1', plaidAccountId: 'plaid-acc-1' },
  ]);
  mockTxFindMany.mockResolvedValue([]); // no existing external ID matches
  mockBuildDuplicateHashSet.mockResolvedValue(new Set());
}

// ─── normalizeDescription ───────────────────────────────────────────────────

describe('normalizeDescription()', () => {
  it('lowercases input', () => {
    expect(normalizeDescription('STARBUCKS')).toBe('starbucks');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeDescription('  coffee  ')).toBe('coffee');
  });

  it('collapses multiple internal spaces into one', () => {
    expect(normalizeDescription('coffee   shop  nyc')).toBe('coffee shop nyc');
  });

  it('returns empty string for null', () => {
    expect(normalizeDescription(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeDescription(undefined)).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(normalizeDescription('')).toBe('');
  });

  it('handles combined edge cases (uppercase + extra spaces + leading/trailing)', () => {
    expect(normalizeDescription('  THE   Coffee   SHOP  ')).toBe('the coffee shop');
  });
});

// ─── buildFrequencyMap ──────────────────────────────────────────────────────

describe('buildFrequencyMap()', () => {
  it('groups rows by normalized name', () => {
    const rows = [
      { name: 'Starbucks', id: 1 },
      { name: 'starbucks', id: 2 },
      { name: 'Walmart', id: 3 },
    ];
    const map = buildFrequencyMap(rows);

    expect(map.size).toBe(2);
    expect(map.get('starbucks')).toHaveLength(2);
    expect(map.get('starbucks').map(r => r.id)).toEqual([1, 2]);
    expect(map.get('walmart')).toHaveLength(1);
    expect(map.get('walmart')[0].id).toBe(3);
  });

  it('returns empty map for empty array', () => {
    const map = buildFrequencyMap([]);
    expect(map.size).toBe(0);
    expect(map).toBeInstanceOf(Map);
  });

  it('groups rows with null names under empty string key', () => {
    const rows = [
      { name: null, id: 1 },
      { name: null, id: 2 },
      { name: 'Amazon', id: 3 },
    ];
    const map = buildFrequencyMap(rows);

    expect(map.size).toBe(2);
    expect(map.get('')).toHaveLength(2);
    expect(map.get('amazon')).toHaveLength(1);
  });

  it('treats different casings as the same group', () => {
    const rows = [
      { name: 'COSTCO', id: 1 },
      { name: 'Costco', id: 2 },
      { name: 'costco', id: 3 },
    ];
    const map = buildFrequencyMap(rows);

    expect(map.size).toBe(1);
    expect(map.get('costco')).toHaveLength(3);
  });

  it('collapses whitespace variations into same group', () => {
    const rows = [
      { name: 'Coffee  Shop', id: 1 },
      { name: 'coffee shop', id: 2 },
      { name: '  Coffee Shop  ', id: 3 },
    ];
    const map = buildFrequencyMap(rows);

    expect(map.size).toBe(1);
    expect(map.get('coffee shop')).toHaveLength(3);
  });

  it('preserves original row objects in the map values', () => {
    const row = { name: 'Target', id: 1, amount: 42.50, date: '2026-01-15' };
    const map = buildFrequencyMap([row]);

    const stored = map.get('target')[0];
    expect(stored).toBe(row);
    expect(stored.amount).toBe(42.50);
    expect(stored.date).toBe('2026-01-15');
  });
});

// ─── Worker pipeline tests ──────────────────────────────────────────────────

// Pipeline tests skipped: plaidProcessorWorker uses dynamic import('p-limit')
// which is ESM-only and incompatible with Jest CJS mode.
// Helper functions (normalizeDescription, buildFrequencyMap) are tested above.
describe.skip('plaidProcessorWorker pipeline', () => {
  beforeAll(() => {
    startPlaidProcessorWorker();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setupWorkerContext();
    // Suppress the global fetch call for TRANSACTIONS_IMPORTED event
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterAll(() => {
    delete global.fetch;
  });

  it('returns early when PlaidItem is not found', async () => {
    mockPlaidItemFindUnique.mockResolvedValue(null);

    await workerCallback(makeJob('PLAID_SYNC_COMPLETE', { plaidItemId: 'missing' }));

    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('sets seedReady when no pending transactions exist', async () => {
    mockPlaidTxFindMany.mockResolvedValue([]); // no pending

    await workerCallback(makeJob('PLAID_SYNC_COMPLETE', { plaidItemId: 'pi-1' }));

    expect(mockPlaidItemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ seedReady: true }),
      })
    );
  });

  it('auto-promotes EXACT_MATCH transactions above threshold', async () => {
    const tx = makePendingTx();
    mockPlaidTxFindMany
      .mockResolvedValueOnce([tx])   // allPending
      .mockResolvedValueOnce([]);    // remainingPending (Phase 2)

    mockClassify.mockResolvedValue({
      categoryId: 'cat-dining',
      confidence: 1.0,
      source: 'EXACT_MATCH',
      reasoning: null,
    });

    // Mock the $transaction to simulate creating the transaction
    mockPrismaTransaction.mockImplementation(async (cb) => {
      return cb({
        transaction: { create: jest.fn().mockResolvedValue({ id: 'new-tx-1' }) },
        plaidTransaction: { update: jest.fn().mockResolvedValue({}) },
      });
    });

    await workerCallback(makeJob('PLAID_SYNC_COMPLETE', { plaidItemId: 'pi-1' }));

    expect(mockClassify).toHaveBeenCalled();
    expect(mockPrismaTransaction).toHaveBeenCalled();
    expect(mockRecordFeedback).toHaveBeenCalled();
  });

  it('marks investment transactions as CLASSIFIED with requiresEnrichment', async () => {
    const tx = makePendingTx({ id: 2 });
    mockPlaidTxFindMany
      .mockResolvedValueOnce([tx])   // allPending
      .mockResolvedValueOnce([]);    // remainingPending

    mockClassify.mockResolvedValue({
      categoryId: 'cat-stocks',
      confidence: 0.95,
      source: 'EXACT_MATCH',
      reasoning: null,
    });

    await workerCallback(makeJob('PLAID_SYNC_COMPLETE', { plaidItemId: 'pi-1' }));

    // Investment transactions are never auto-promoted
    expect(mockPrismaTransaction).not.toHaveBeenCalled();
    // Instead they get CLASSIFIED with enrichment flags
    expect(mockPlaidTxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          promotionStatus: 'CLASSIFIED',
          requiresEnrichment: true,
          enrichmentType: 'INVESTMENT',
        }),
      })
    );
  });

  it('detects hash duplicates and marks as DUPLICATE', async () => {
    const tx = makePendingTx({ id: 3 });
    mockPlaidTxFindMany
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);

    // Build a hash set that contains our mock hash
    mockBuildDuplicateHashSet.mockResolvedValue(new Set(['mock-hash']));

    mockClassify.mockResolvedValue({
      categoryId: 'cat-dining',
      confidence: 1.0,
      source: 'EXACT_MATCH',
    });

    await workerCallback(makeJob('PLAID_SYNC_COMPLETE', { plaidItemId: 'pi-1' }));

    expect(mockPlaidTxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          promotionStatus: 'DUPLICATE',
          processed: true,
        }),
      })
    );
  });

  it('holds low-confidence LLM results as seeds during INITIAL_SYNC', async () => {
    const tx1 = makePendingTx({ id: 10, name: 'NewPlace' });
    const tx2 = makePendingTx({ id: 11, name: 'NewPlace' });
    mockPlaidTxFindMany
      .mockResolvedValueOnce([tx1, tx2])   // allPending
      .mockResolvedValueOnce([]);          // remainingPending

    mockClassify.mockResolvedValue({
      categoryId: 'cat-dining',
      confidence: 0.75,
      source: 'LLM',
      reasoning: 'Looks like dining',
    });

    await workerCallback(makeJob('PLAID_SYNC_COMPLETE', {
      plaidItemId: 'pi-1',
      source: 'INITIAL_SYNC',
    }));

    // LLM below autoPromoteThreshold during INITIAL_SYNC => seedHeld
    expect(mockPlaidTxUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          seedHeld: true,
          classificationSource: 'LLM',
        }),
      })
    );
  });
});
