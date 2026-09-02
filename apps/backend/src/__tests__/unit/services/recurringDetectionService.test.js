// Unit tests for the recurring-charge detection service.
// Prisma is fully mocked; these tests exercise the pure heuristic logic.

jest.mock('../../../../prisma/prisma', () => ({
  recurringCharge: { findMany: jest.fn() },
  transaction: { count: jest.fn(), findMany: jest.fn() },
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../../../prisma/prisma');
const {
  detectForTenant,
  normalizeMerchant,
  hashMerchant,
  inferCadence,
  isAmountStable,
  computeNextExpected,
  computeStatus,
  bucketForGap,
} = require('../../../services/recurringDetectionService');

const TENANT = 'tenant-1';
const RECURRING_CAT = { id: 10, name: 'Content & Media', icon: '📺', isRecurring: true, type: 'Lifestyle' };
const SPENDING_CAT = { id: 20, name: 'Sports & Gym', icon: '🏋️', isRecurring: false, type: 'Lifestyle' };

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function txn(id, description, debit, date, category) {
  return {
    id,
    description,
    debit,
    currency: 'USD',
    transaction_date: date,
    categoryId: category.id,
    category,
  };
}

/** Wire prisma mocks: tierA rows returned for isRecurring=true, tierB for isRecurring=false. */
function mockTxns({ tierA = [], tierB = [], tierBCount = null, prior = [] }) {
  prisma.recurringCharge.findMany.mockResolvedValue(prior);
  prisma.transaction.count.mockResolvedValue(tierBCount == null ? tierB.length : tierBCount);
  prisma.transaction.findMany.mockImplementation(({ where }) => {
    const isRecurring = where?.category?.is?.isRecurring;
    return Promise.resolve(isRecurring ? tierA : tierB);
  });
}

beforeEach(() => jest.clearAllMocks());

describe('normalizeMerchant / hashMerchant', () => {
  it('strips card masks, dates, ref numbers and punctuation', () => {
    expect(normalizeMerchant('NETFLIX.COM  xxxx1234  04/12  #00421')).toBe('netflix com');
  });

  it('produces a stable hash for the same merchant across noisy variants', () => {
    const a = hashMerchant('SPOTIFY P0345  03/01 CARD PURCHASE');
    const b = hashMerchant('SPOTIFY P0987  11/22 CARD PURCHASE');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('inferCadence', () => {
  it('buckets ~30-day gaps as MONTHLY', () => {
    const dates = [daysAgo(90), daysAgo(60), daysAgo(30), daysAgo(0)];
    expect(inferCadence(dates).cadence).toBe('MONTHLY');
  });
  it('buckets ~7-day gaps as WEEKLY', () => {
    const dates = [daysAgo(21), daysAgo(14), daysAgo(7), daysAgo(0)];
    expect(inferCadence(dates).cadence).toBe('WEEKLY');
  });
  it('buckets ~365-day gaps as ANNUAL', () => {
    expect(bucketForGap(365)).toBe('ANNUAL');
  });
  it('returns null cadence for a single occurrence', () => {
    expect(inferCadence([new Date()]).cadence).toBeNull();
  });
});

describe('isAmountStable', () => {
  it('accepts small drift within tolerance', () => {
    expect(isAmountStable([9.99, 9.99, 10.49])).toBe(true);
  });
  it('rejects large swings', () => {
    expect(isAmountStable([10, 10, 45])).toBe(false);
  });
});

describe('computeNextExpected / computeStatus', () => {
  it('adds one nominal cadence period', () => {
    const next = computeNextExpected(new Date('2026-08-01T00:00:00Z'), 'MONTHLY');
    expect(next.toISOString().slice(0, 10)).toBe('2026-08-31');
  });
  it('marks a charge LAPSED past 1.5× cadence', () => {
    expect(computeStatus(daysAgo(60), 'MONTHLY', new Date())).toBe('LAPSED');
    expect(computeStatus(daysAgo(20), 'MONTHLY', new Date())).toBe('ACTIVE');
  });
});

describe('detectForTenant', () => {
  it('Tier A: a single charge in an isRecurring category qualifies', async () => {
    mockTxns({ tierA: [txn(1, 'SPOTIFY EU', 9.99, daysAgo(3), RECURRING_CAT)] });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].detectionReason).toBe('CATEGORY_SIGNAL');
    expect(rows[0].occurrenceCount).toBe(1);
    expect(rows[0].cadence).toBe('MONTHLY');
    expect(rows[0].status).toBe('ACTIVE');
  });

  it('Tier B: 3 regular same-amount charges qualify as MONTHLY', async () => {
    const tierB = [
      txn(1, 'CITY GYM', 29.99, daysAgo(90), SPENDING_CAT),
      txn(2, 'CITY GYM', 29.99, daysAgo(60), SPENDING_CAT),
      txn(3, 'CITY GYM', 30.49, daysAgo(30), SPENDING_CAT),
    ];
    mockTxns({ tierB });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].detectionReason).toBe('INTERVAL_HEURISTIC');
    expect(rows[0].cadence).toBe('MONTHLY');
    expect(rows[0].occurrenceCount).toBe(3);
    const expectedNext = computeNextExpected(daysAgo(30), 'MONTHLY').toISOString().slice(0, 10);
    expect(rows[0].nextExpectedAt.toISOString().slice(0, 10)).toBe(expectedNext);
  });

  it('Tier B: fewer than 3 occurrences do not qualify', async () => {
    mockTxns({
      tierB: [
        txn(1, 'RARE SHOP', 12, daysAgo(60), SPENDING_CAT),
        txn(2, 'RARE SHOP', 12, daysAgo(30), SPENDING_CAT),
      ],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(0);
  });

  it('Tier B: irregular gaps do not qualify', async () => {
    mockTxns({
      tierB: [
        txn(1, 'ADHOC', 20, daysAgo(120), SPENDING_CAT),
        txn(2, 'ADHOC', 20, daysAgo(50), SPENDING_CAT),
        txn(3, 'ADHOC', 20, daysAgo(40), SPENDING_CAT),
        txn(4, 'ADHOC', 20, daysAgo(2), SPENDING_CAT),
      ],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(0);
  });

  it('Tier B: skipped when the row cap is exceeded', async () => {
    mockTxns({ tierB: [], tierBCount: 999999 });
    const { rows, tierBSkipped } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(tierBSkipped).toBe(true);
    expect(rows).toHaveLength(0);
    // findMany should only have been consulted for Tier A
    expect(prisma.transaction.findMany).toHaveBeenCalledTimes(1);
  });

  it('honours a DISMISSED tombstone', async () => {
    const dismissedHash = hashMerchant('CITY GYM');
    mockTxns({
      prior: [{ descriptionHash: dismissedHash, state: 'DISMISSED', cadence: null, userCadenceLocked: false }],
      tierB: [
        txn(1, 'CITY GYM', 29.99, daysAgo(120), SPENDING_CAT),
        txn(2, 'CITY GYM', 29.99, daysAgo(90), SPENDING_CAT),
        txn(3, 'CITY GYM', 29.99, daysAgo(60), SPENDING_CAT),
        txn(4, 'CITY GYM', 29.99, daysAgo(30), SPENDING_CAT),
      ],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(0);
  });

  it('force-includes a CONFIRMED merchant the heuristic would skip', async () => {
    const confirmedHash = hashMerchant('ODD MERCHANT');
    mockTxns({
      prior: [{ descriptionHash: confirmedHash, state: 'CONFIRMED', cadence: null, userCadenceLocked: false }],
      tierB: [txn(1, 'ODD MERCHANT', 5, daysAgo(10), SPENDING_CAT)],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].detectionReason).toBe('USER_CONFIRMED');
  });

  it('marks a stale merchant LAPSED', async () => {
    mockTxns({ tierA: [txn(1, 'OLD NEWS', 4.99, daysAgo(200), RECURRING_CAT)] });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows[0].status).toBe('LAPSED');
  });

  it('picks the dominant currency across occurrences', async () => {
    prisma.recurringCharge.findMany.mockResolvedValue([]);
    prisma.transaction.count.mockResolvedValue(0);
    prisma.transaction.findMany.mockImplementation(({ where }) => {
      if (where?.category?.is?.isRecurring) {
        return Promise.resolve([
          { id: 1, description: 'MULTI', debit: 9.99, currency: 'EUR', transaction_date: daysAgo(60), categoryId: 10, category: RECURRING_CAT },
          { id: 2, description: 'MULTI', debit: 9.99, currency: 'EUR', transaction_date: daysAgo(30), categoryId: 10, category: RECURRING_CAT },
          { id: 3, description: 'MULTI', debit: 11.5, currency: 'USD', transaction_date: daysAgo(1), categoryId: 10, category: RECURRING_CAT },
        ]);
      }
      return Promise.resolve([]);
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows[0].currency).toBe('EUR');
  });

  it('full mode widens the Tier A window', async () => {
    mockTxns({ tierA: [txn(1, 'YEARLY', 99, daysAgo(400), RECURRING_CAT)] });
    await detectForTenant(TENANT, { mode: 'full' });
    const call = prisma.transaction.findMany.mock.calls.find(([a]) => a.where?.category?.is?.isRecurring);
    const gte = call[0].where.transaction_date.gte;
    // full-scan lookback is 48 months → well over a year ago
    expect(Date.now() - gte.getTime()).toBeGreaterThan(365 * 86_400_000);
  });
});
