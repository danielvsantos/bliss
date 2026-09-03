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
  sha256Hex,
  clusterByAmount,
  clusterKey,
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

/**
 * Wire prisma mocks: tierA rows returned for isRecurring=true, tierB for
 * isRecurring=false. `prior` feeds the CONFIRMED/DISMISSED/locked-cadence query.
 * `merges` feeds the manual-merge alias query — each entry is
 * `{ descriptionHash, mergedIntoHash, target? }` where `target` (optional) is the
 * merge-target metadata row `{ descriptionHash, merchantLabel, categoryId,
 * cadence, currency }`.
 */
function mockTxns({ tierA = [], tierB = [], tierBCount = null, prior = [], merges = [] }) {
  prisma.recurringCharge.findMany.mockImplementation(({ where }) => {
    // aliasRows — where: { mergedIntoHash: { not: null } }
    if (where?.mergedIntoHash && typeof where.mergedIntoHash === 'object') {
      return Promise.resolve(
        merges.map((m) => ({ descriptionHash: m.descriptionHash, mergedIntoHash: m.mergedIntoHash })),
      );
    }
    // aliasTargets — where: { descriptionHash: { in: [...] } }
    if (where?.descriptionHash?.in) {
      return Promise.resolve(merges.filter((m) => m.target).map((m) => m.target));
    }
    // priorRows — where: { mergedIntoHash: null, OR: [...] }
    return Promise.resolve(prior);
  });
  prisma.transaction.count.mockResolvedValue(tierBCount == null ? tierB.length : tierBCount);
  prisma.transaction.findMany.mockImplementation(({ where }) => {
    const isRecurring = where?.category?.is?.isRecurring;
    return Promise.resolve(isRecurring ? tierA : tierB);
  });
}

beforeEach(() => jest.clearAllMocks());

describe('normalizeMerchant / hashMerchant', () => {
  it('strips TLDs, card masks, dates, ref numbers and punctuation', () => {
    expect(normalizeMerchant('NETFLIX.COM  xxxx1234  04/12  #00421')).toBe('netflix');
  });

  it('produces a stable hash for the same merchant across noisy variants', () => {
    const a = hashMerchant('SPOTIFY P0345  03/01 CARD PURCHASE');
    const b = hashMerchant('SPOTIFY P0987  11/22 CARD PURCHASE');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('collapses real-world descriptor variants of one merchant to a single key', () => {
    const variants = [
      'Netflix',
      'NETFLIX.COM',
      'NETFLIX.COM #04821',
      'SQ *NETFLIX',
      'PAYPAL *NETFLIX',
      'TST* NETFLIX',
      'NETFLIX 08/15 POS DEBIT',
      'Netflix Inc',
      'Netflix 4',
      'NÉTFLIX',
    ];
    const keys = new Set(variants.map(normalizeMerchant));
    expect(keys).toEqual(new Set(['netflix']));
  });

  it('keeps genuinely different merchants distinct (no first-word merge)', () => {
    expect(normalizeMerchant('Netflix')).not.toBe(normalizeMerchant('Netflix Games'));
    // the aggregator-prefix strip is an allow-list — a merchant's own short name
    // (e.g. "ADOBE *…") must not be treated as a processor code
    expect(normalizeMerchant('ADOBE *CREATIVE CLD')).toBe('adobe creative cld');
  });

  it('never returns an empty key for a URL-only descriptor', () => {
    expect(normalizeMerchant('www.audible.com/manage')).toBe('audible manage');
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

  it('scans Ventures categories via Tier B (business subscriptions)', async () => {
    const cloud = { id: 30, name: 'Cloud & Hosting', isRecurring: false, type: 'Ventures' };
    mockTxns({
      tierB: [
        txn(1, 'AWS', 42.0, daysAgo(90), cloud),
        txn(2, 'AWS', 42.0, daysAgo(60), cloud),
        txn(3, 'AWS', 43.5, daysAgo(30), cloud),
      ],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].detectionReason).toBe('INTERVAL_HEURISTIC');
    expect(rows[0].cadence).toBe('MONTHLY');
  });
});

describe('clusterByAmount', () => {
  const occ = (debit) => ({ debit, transaction_date: new Date(), currency: 'EUR' });

  it('does not split a merchant with fewer than the min-group occurrences', () => {
    expect(clusterByAmount([occ(3), occ(3), occ(10), occ(10), occ(22)])).toHaveLength(1);
  });

  it('splits a busy merchant into distinct amount bands', () => {
    const input = [
      occ(2.99), occ(2.99), occ(2.99), occ(2.99),
      occ(9.99), occ(9.99), occ(9.99), occ(9.99),
      occ(22), occ(22), occ(22),
    ];
    const bands = clusterByAmount(input).map((b) => b.length).sort();
    expect(bands).toEqual([3, 4, 4]);
  });

  it('keeps sub-unit drift in one band', () => {
    const input = [occ(9.99), occ(10.49), occ(9.99), occ(10.99), occ(9.99), occ(10.49)];
    expect(clusterByAmount(input)).toHaveLength(1);
  });

  it('isolates a lone large charge into its own band', () => {
    const input = [
      occ(9.99), occ(9.99), occ(9.99), occ(9.99), occ(9.99), occ(9.99),
      occ(39.99),
    ];
    const bands = clusterByAmount(input).map((b) => b.length).sort();
    expect(bands).toEqual([1, 6]);
  });

  it('clusterKey rounds a band median to a whole currency unit', () => {
    expect(clusterKey(9.99)).toBe('10');
    expect(clusterKey(2.49)).toBe('2');
    expect(clusterKey(0.4)).toBe('1'); // floor of 1
  });
});

describe('detectForTenant — aggregator merchant splitting', () => {
  const MEDIA = { id: 40, name: 'App Store', icon: '📺', isRecurring: true, type: 'Lifestyle' };

  function appleFixture() {
    const rows = [];
    let id = 1;
    // €2.99 ×4 monthly, €9.99 ×4 monthly, €22 ×3 monthly, one €39.99 purchase
    for (const [amt, count] of [[2.99, 4], [9.99, 4], [22, 3]]) {
      for (let i = 0; i < count; i++) {
        rows.push({
          id: id++, description: 'APPLE.COM/BILL', debit: amt, currency: 'EUR',
          transaction_date: daysAgo(15 + i * 30), categoryId: MEDIA.id, category: MEDIA,
        });
      }
    }
    rows.push({
      id: id++, description: 'APPLE.COM/BILL', debit: 39.99, currency: 'EUR',
      transaction_date: daysAgo(20), categoryId: MEDIA.id, category: MEDIA,
    });
    return rows;
  }

  it('produces one row per recurring price band and drops the lone purchase', async () => {
    mockTxns({ tierA: appleFixture() });
    const { rows, legacyRetireHashes } = await detectForTenant(TENANT, { mode: 'full' });

    const amounts = rows.map((r) => Number(r.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([2.99, 9.99, 22]); // stored amount = the real band median; no €39.99 row
    expect(rows.every((r) => r.currency === 'EUR')).toBe(true);

    // each band row is keyed as "<merchant>#<rounded median>"
    const key = normalizeMerchant('APPLE.COM/BILL');
    expect(new Set(rows.map((r) => r.descriptionHash))).toEqual(
      new Set([sha256Hex(`${key}#3`), sha256Hex(`${key}#10`), sha256Hex(`${key}#22`)]),
    );
    // the pre-clustering bare "apple" row is scheduled for retirement
    expect(legacyRetireHashes).toEqual([sha256Hex(key)]);
  });

  it('a single-price merchant is unchanged (bare hash, nothing retired)', async () => {
    mockTxns({
      tierA: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1, description: 'Netflix', debit: 15.99, currency: 'USD',
        transaction_date: daysAgo(10 + i * 30), categoryId: MEDIA.id, category: MEDIA,
      })),
    });
    const { rows, legacyRetireHashes } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(hashMerchant('Netflix'));
    expect(legacyRetireHashes).toEqual([]);
  });

  it('honours a DISMISSED tombstone on a specific band', async () => {
    const key = normalizeMerchant('APPLE.COM/BILL');
    mockTxns({
      tierA: appleFixture(),
      prior: [{ descriptionHash: sha256Hex(`${key}#10`), state: 'DISMISSED', cadence: null, userCadenceLocked: false }],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'full' });
    const amounts = rows.map((r) => Number(r.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([2.99, 22]); // the €9.99 band is suppressed
  });
});

describe('detectForTenant — manual merchant merge', () => {
  const ORANGE = { id: 50, name: 'Telecom', icon: '📱', isRecurring: true, type: 'Essentials' };

  it('folds the source merchant\'s charges into the target row and emits no standalone source row', async () => {
    const sourceHash = hashMerchant('To Orange Espagne S.a.');
    const targetHash = hashMerchant('Orange');
    mockTxns({
      tierA: [
        txn(1, 'Orange', 30, daysAgo(90), ORANGE),
        txn(2, 'Orange', 30, daysAgo(60), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(30), ORANGE),
        txn(4, 'To Orange Espagne S.a.', 30, daysAgo(2), ORANGE),
      ],
      merges: [{
        descriptionHash: sourceHash,
        mergedIntoHash: targetHash,
        target: { descriptionHash: targetHash, merchantLabel: 'Orange', categoryId: ORANGE.id, cadence: 'MONTHLY', currency: 'USD' },
      }],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(targetHash);
    expect(rows[0].occurrenceCount).toBe(4); // 2 Orange + 2 folded-in
    // the target's own label survives even though the folded-in charges are newer
    expect(rows[0].merchantLabel).toBe('Orange');
    // most-recent contributing charge is one of the folded-in transactions
    expect(rows[0].contributingTransactionIds).toContain(4);
  });

  it('resolves a merge chain (A→B→C) to the final target', async () => {
    const aHash = hashMerchant('Orange ES old');
    const bHash = hashMerchant('To Orange Espagne S.a.');
    const cHash = hashMerchant('Orange');
    mockTxns({
      tierA: [
        txn(1, 'Orange', 30, daysAgo(60), ORANGE),
        txn(2, 'Orange ES old', 30, daysAgo(30), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(3), ORANGE),
      ],
      merges: [
        { descriptionHash: aHash, mergedIntoHash: bHash },
        { descriptionHash: bHash, mergedIntoHash: cHash },
      ],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(cHash);
    expect(rows[0].occurrenceCount).toBe(3);
  });

  it('does not re-split a merged group by amount even when the bands diverge', async () => {
    const sourceHash = hashMerchant('APPLE ES');
    const targetHash = hashMerchant('APPLE.COM/BILL');
    const tierA = [];
    let id = 1;
    for (let i = 0; i < 6; i++) {
      tierA.push(txn(id++, 'APPLE.COM/BILL', 2.99, daysAgo(20 + i * 30), ORANGE));
    }
    for (let i = 0; i < 4; i++) {
      tierA.push(txn(id++, 'APPLE ES', 49.99, daysAgo(15 + i * 30), ORANGE));
    }
    mockTxns({ tierA, merges: [{ descriptionHash: sourceHash, mergedIntoHash: targetHash }] });
    const { rows, legacyRetireHashes } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1); // one combined row, NOT one per band
    expect(rows[0].descriptionHash).toBe(targetHash);
    expect(rows[0].occurrenceCount).toBe(10);
    expect(legacyRetireHashes).toEqual([]); // a merged row is never a "split"
  });

  it('synthesizes a target row from folded-in charges when the target has no charges this window', async () => {
    const sourceHash = hashMerchant('To Orange Espagne S.a.');
    const targetHash = hashMerchant('Orange');
    mockTxns({
      tierA: [
        txn(1, 'To Orange Espagne S.a.', 30, daysAgo(60), ORANGE),
        txn(2, 'To Orange Espagne S.a.', 30, daysAgo(30), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(3), ORANGE),
      ],
      merges: [{
        descriptionHash: sourceHash,
        mergedIntoHash: targetHash,
        target: { descriptionHash: targetHash, merchantLabel: 'Orange', categoryId: ORANGE.id, cadence: 'MONTHLY', currency: 'USD' },
      }],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(targetHash);
    expect(rows[0].merchantLabel).toBe('Orange'); // from target metadata, not the source descriptor
    expect(rows[0].occurrenceCount).toBe(3);
    expect(rows[0].cadence).toBe('MONTHLY');
  });

  it('a DISMISSED target still suppresses the synthesized row', async () => {
    const sourceHash = hashMerchant('To Orange Espagne S.a.');
    const targetHash = hashMerchant('Orange');
    mockTxns({
      tierA: [
        txn(1, 'To Orange Espagne S.a.', 30, daysAgo(60), ORANGE),
        txn(2, 'To Orange Espagne S.a.', 30, daysAgo(30), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(3), ORANGE),
      ],
      prior: [{ descriptionHash: targetHash, state: 'DISMISSED', cadence: null, userCadenceLocked: false }],
      merges: [{ descriptionHash: sourceHash, mergedIntoHash: targetHash }],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(0);
  });
});
