jest.mock('../../../queues/plaidProcessingQueue', () => ({
  getPlaidProcessingQueue: jest.fn(),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
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

jest.mock('../../../../prisma/prisma', () => ({
  plaidTransaction: { update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  plaidItem: { findUnique: jest.fn(), update: jest.fn() },
  tenant: { findUnique: jest.fn() },
  account: { findMany: jest.fn() },
  transaction: { create: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../../services/categorizationService', () => ({
  classify: jest.fn(),
  recordFeedback: jest.fn(),
}));

jest.mock('../../../utils/descriptionCache', () => ({
  warmDescriptionCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../utils/categoryCache', () => ({
  getCategoriesForTenant: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../services/geminiService', () => ({
  isRateLimitError: jest.fn().mockReturnValue(false),
}));

jest.mock('../../../utils/transactionHash', () => ({
  computeTransactionHash: jest.fn().mockReturnValue('mock-hash'),
  buildDuplicateHashSet: jest.fn().mockResolvedValue(new Set()),
}));

jest.mock('../../../config/classificationConfig', () => ({
  DEFAULT_AUTO_PROMOTE_THRESHOLD: 0.90,
  DEFAULT_REVIEW_THRESHOLD: 0.70,
  TOP_N_SEEDS: 10,
  PHASE2_CONCURRENCY: 3,
}));

const { normalizeDescription, buildFrequencyMap } = require('../../../workers/plaidProcessorWorker');

// ─── normalizeDescription ────────────────────────────────────────────────────

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

// ─── buildFrequencyMap ───────────────────────────────────────────────────────

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
