/**
 * Unit tests for calculateAnalytics() in analyticsWorker.js
 *
 * Focuses on verifying that the tag analytics map is populated correctly
 * alongside the regular analytics map. Prisma, currency services, and
 * external dependencies are mocked.
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

jest.mock('../../../queues/analyticsQueue', () => ({
  ANALYTICS_QUEUE_NAME: 'test-analytics',
  getAnalyticsQueue: jest.fn(),
}));

jest.mock('../../../queues/eventsQueue', () => ({
  enqueueEvent: jest.fn(),
}));

jest.mock('../../../services/currencyService', () => ({
  getOrCreateCurrencyRate: jest.fn(),
  getRatesForDateRange: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../../../utils/categoryCache', () => ({
  getCategoryMaps: jest.fn(),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('@sentry/node', () => ({
  withScope: jest.fn(),
  captureException: jest.fn(),
}));

const mockFindMany = jest.fn();
jest.mock('../../../../prisma/prisma.js', () => ({
  transaction: {
    findMany: (...args) => mockFindMany(...args),
  },
  tenantCurrency: {
    findMany: jest.fn(),
  },
  analyticsCacheMonthly: {
    upsert: jest.fn(),
  },
  tagAnalyticsCacheMonthly: {
    upsert: jest.fn(),
  },
  $transaction: jest.fn((promises) => Promise.all(promises)),
}));

const { calculateAnalytics } = require('../../../workers/analyticsWorker');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTxn({ id, year, month, date, currency, credit, debit, country, type, group, categoryId = 0, categoryName = 'Uncategorized', tagIds = [] }) {
  return {
    id,
    year,
    month,
    transaction_date: new Date(date),
    currency,
    credit,
    debit,
    account: { countryId: country },
    category: { id: categoryId, name: categoryName, type, group },
    tags: tagIds.map(tagId => ({ tagId })),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('calculateAnalytics — tag analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('populates tagAnalyticsMap for transactions with tags', async () => {
    const txn1 = makeTxn({
      id: 1, year: 2026, month: 3, date: '2026-03-15',
      currency: 'USD', credit: 0, debit: 100,
      country: 'US', type: 'Expense', group: 'Dining',
      categoryId: 10, categoryName: 'Sushi',
      tagIds: [5],
    });
    const txn2 = makeTxn({
      id: 2, year: 2026, month: 3, date: '2026-03-16',
      currency: 'USD', credit: 0, debit: 50,
      country: 'US', type: 'Expense', group: 'Transport',
      categoryId: 20, categoryName: 'Train',
      tagIds: [5],
    });

    // Pass 1: date discovery (minimal fields)
    mockFindMany.mockResolvedValueOnce([
      { id: 1, transaction_date: new Date('2026-03-15'), currency: 'USD', account: { countryId: 'US' }, category: { type: 'Expense', group: 'Dining' } },
      { id: 2, transaction_date: new Date('2026-03-16'), currency: 'USD', account: { countryId: 'US' }, category: { type: 'Expense', group: 'Transport' } },
    ]);
    // Pass 1: end of batch
    mockFindMany.mockResolvedValueOnce([]);
    // Pass 2: full transactions
    mockFindMany.mockResolvedValueOnce([txn1, txn2]);
    // Pass 2: end of batch
    mockFindMany.mockResolvedValueOnce([]);

    const result = await calculateAnalytics('tenant-1', {}, ['USD']);

    expect(result.analytics).toHaveLength(2); // Dining + Transport
    expect(result.tagAnalytics).toHaveLength(2); // Tag 5: Sushi + Train

    const tagSushi = result.tagAnalytics.find(e => e.categoryName === 'Sushi');
    expect(tagSushi).toBeDefined();
    expect(tagSushi.tagId).toBe(5);
    expect(tagSushi.categoryId).toBe(10);
    expect(tagSushi.debit.toNumber()).toBe(100);

    const tagTrain = result.tagAnalytics.find(e => e.categoryName === 'Train');
    expect(tagTrain).toBeDefined();
    expect(tagTrain.tagId).toBe(5);
    expect(tagTrain.categoryId).toBe(20);
    expect(tagTrain.debit.toNumber()).toBe(50);
  });

  it('creates separate entries for multi-tagged transactions', async () => {
    const txn = makeTxn({
      id: 1, year: 2026, month: 3, date: '2026-03-15',
      currency: 'USD', credit: 0, debit: 200,
      country: 'US', type: 'Expense', group: 'Dining',
      categoryId: 10, categoryName: 'Sushi',
      tagIds: [5, 12], // Two tags
    });

    mockFindMany.mockResolvedValueOnce([
      { id: 1, transaction_date: new Date('2026-03-15'), currency: 'USD', account: { countryId: 'US' }, category: { type: 'Expense', group: 'Dining' } },
    ]);
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([txn]);
    mockFindMany.mockResolvedValueOnce([]);

    const result = await calculateAnalytics('tenant-1', {}, ['USD']);

    expect(result.analytics).toHaveLength(1); // One regular entry
    expect(result.tagAnalytics).toHaveLength(2); // One per tag

    const tag5 = result.tagAnalytics.find(e => e.tagId === 5);
    const tag12 = result.tagAnalytics.find(e => e.tagId === 12);
    expect(tag5.debit.toNumber()).toBe(200);
    expect(tag12.debit.toNumber()).toBe(200);
  });

  it('skips tag analytics for untagged transactions', async () => {
    const txn = makeTxn({
      id: 1, year: 2026, month: 3, date: '2026-03-15',
      currency: 'USD', credit: 0, debit: 100,
      country: 'US', type: 'Expense', group: 'Dining',
      tagIds: [], // No tags
    });

    mockFindMany.mockResolvedValueOnce([
      { id: 1, transaction_date: new Date('2026-03-15'), currency: 'USD', account: { countryId: 'US' }, category: { type: 'Expense', group: 'Dining' } },
    ]);
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([txn]);
    mockFindMany.mockResolvedValueOnce([]);

    const result = await calculateAnalytics('tenant-1', {}, ['USD']);

    expect(result.analytics).toHaveLength(1); // Regular entry still created
    expect(result.tagAnalytics).toHaveLength(0); // No tag entries
  });

  it('aggregates same tag + category across multiple transactions', async () => {
    const txn1 = makeTxn({
      id: 1, year: 2026, month: 3, date: '2026-03-10',
      currency: 'USD', credit: 0, debit: 100,
      country: 'US', type: 'Expense', group: 'Dining',
      categoryId: 10, categoryName: 'Sushi',
      tagIds: [5],
    });
    const txn2 = makeTxn({
      id: 2, year: 2026, month: 3, date: '2026-03-20',
      currency: 'USD', credit: 0, debit: 75,
      country: 'US', type: 'Expense', group: 'Dining',
      categoryId: 10, categoryName: 'Sushi',
      tagIds: [5],
    });

    mockFindMany.mockResolvedValueOnce([
      { id: 1, transaction_date: new Date('2026-03-10'), currency: 'USD', account: { countryId: 'US' }, category: { type: 'Expense', group: 'Dining' } },
      { id: 2, transaction_date: new Date('2026-03-20'), currency: 'USD', account: { countryId: 'US' }, category: { type: 'Expense', group: 'Dining' } },
    ]);
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([txn1, txn2]);
    mockFindMany.mockResolvedValueOnce([]);

    const result = await calculateAnalytics('tenant-1', {}, ['USD']);

    expect(result.tagAnalytics).toHaveLength(1); // Aggregated into one entry
    expect(result.tagAnalytics[0].tagId).toBe(5);
    expect(result.tagAnalytics[0].debit.toNumber()).toBe(175); // 100 + 75
  });

  it('returns both analytics and tagAnalytics in result shape', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]); // Pass 1 empty (no pass 2 needed since count is 0)

    const result = await calculateAnalytics('tenant-1', {}, ['USD']);

    expect(result).toHaveProperty('analytics');
    expect(result).toHaveProperty('tagAnalytics');
    expect(Array.isArray(result.analytics)).toBe(true);
    expect(Array.isArray(result.tagAnalytics)).toBe(true);
  });
});
