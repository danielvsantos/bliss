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
  runKeyFor,
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

let _rowIdSeq = 1000;

/**
 * Build a full `RecurringCharge` row as the detector now loads it (one
 * `findMany({ where: { tenantId } })` with every field). Only `descriptionHash`
 * is required; everything else defaults.
 */
function existingRow(o) {
  return {
    id: o.id ?? (_rowIdSeq += 1),
    descriptionHash: o.descriptionHash,
    chargeKey: o.chargeKey ?? null,
    state: o.state ?? 'DETECTED',
    cadence: o.cadence ?? null,
    userCadenceLocked: o.userCadenceLocked ?? false,
    userLabelLocked: o.userLabelLocked ?? false,
    mergedIntoHash: o.mergedIntoHash ?? null,
    merchantLabel: o.merchantLabel ?? null,
    categoryId: o.categoryId ?? null,
    currency: o.currency ?? null,
    contributingTransactionIds: o.contributingTransactionIds ?? [],
  };
}

/**
 * Wire prisma mocks: tierA rows returned for isRecurring=true, tierB for
 * isRecurring=false. `existing` feeds the single "load every row for this
 * tenant" query the detector now issues (user decisions, merge tombstones,
 * chargeKey identity and the transaction-overlap index all derive from it).
 */
function mockTxns({ tierA = [], tierB = [], tierBCount = null, existing = [] }) {
  prisma.recurringCharge.findMany.mockResolvedValue(existing);
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
      existing: [existingRow({ descriptionHash: dismissedHash, state: 'DISMISSED' })],
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
      existing: [existingRow({ descriptionHash: confirmedHash, state: 'CONFIRMED' })],
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
    const { rows, reconciliations } = await detectForTenant(TENANT, { mode: 'full' });

    const amounts = rows.map((r) => Number(r.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([2.99, 9.99, 22]); // stored amount = the real band median; no €39.99 row
    expect(rows.every((r) => r.currency === 'EUR')).toBe(true);

    // each band row is keyed as "<merchant>#<rounded median>"
    const key = normalizeMerchant('APPLE.COM/BILL');
    expect(new Set(rows.map((r) => r.descriptionHash))).toEqual(
      new Set([sha256Hex(`${key}#3`), sha256Hex(`${key}#10`), sha256Hex(`${key}#22`)]),
    );
    // each band carries its own durable chargeKey (identical to its hash on a
    // brand-new row)
    expect(rows.every((r) => r.chargeKey === r.descriptionHash)).toBe(true);
    // no prior decided rows → nothing to reconcile
    expect(reconciliations).toEqual([]);
  });

  it('a single-price merchant is unchanged (bare hash, nothing reconciled)', async () => {
    mockTxns({
      tierA: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1, description: 'Netflix', debit: 15.99, currency: 'USD',
        transaction_date: daysAgo(10 + i * 30), categoryId: MEDIA.id, category: MEDIA,
      })),
    });
    const { rows, reconciliations } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(hashMerchant('Netflix'));
    expect(rows[0].chargeKey).toBe(hashMerchant('Netflix'));
    expect(reconciliations).toEqual([]);
  });

  it('honours a DISMISSED tombstone on a specific band', async () => {
    const key = normalizeMerchant('APPLE.COM/BILL');
    mockTxns({
      tierA: appleFixture(),
      existing: [existingRow({
        descriptionHash: sha256Hex(`${key}#10`),
        chargeKey: sha256Hex(`${key}#10`),
        state: 'DISMISSED',
      })],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'full' });
    const amounts = rows.map((r) => Number(r.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([2.99, 22]); // the €9.99 band is suppressed
  });
});

describe('runKeyFor', () => {
  it('is the bare merchant hash for a single-price merchant', () => {
    expect(runKeyFor('netflix')).toBe(sha256Hex('netflix'));
    expect(runKeyFor('netflix', { isSplit: false })).toBe(sha256Hex('netflix'));
  });
  it('appends the rounded band median for a split merchant', () => {
    expect(runKeyFor('apple bill', { isSplit: true, bandMedian: 9.99 })).toBe(sha256Hex('apple bill#10'));
    expect(runKeyFor('apple bill', { isSplit: true, bandMedian: 2.49 })).toBe(sha256Hex('apple bill#2'));
  });
});

describe('detectForTenant — manual merchant merge', () => {
  const ORANGE = { id: 50, name: 'Telecom', icon: '📱', isRecurring: true, type: 'Essentials' };

  // A post-reset merge: source row's chargeKey is repointed to the target's.
  const mergedSource = (sourceHash, target) => existingRow({
    descriptionHash: sourceHash,
    chargeKey: target.chargeKey ?? target.descriptionHash,
    mergedIntoHash: target.descriptionHash,
    merchantLabel: 'source descriptor',
    currency: target.currency ?? 'USD',
  });

  it('folds the source merchant\'s charges into the target row and emits no standalone source row', async () => {
    const sourceHash = hashMerchant('To Orange Espagne S.a.');
    const targetHash = hashMerchant('Orange');
    const target = existingRow({
      id: 1, descriptionHash: targetHash, chargeKey: targetHash,
      merchantLabel: 'Orange', categoryId: ORANGE.id, cadence: 'MONTHLY', currency: 'USD',
    });
    mockTxns({
      tierA: [
        txn(1, 'Orange', 30, daysAgo(90), ORANGE),
        txn(2, 'Orange', 30, daysAgo(60), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(30), ORANGE),
        txn(4, 'To Orange Espagne S.a.', 30, daysAgo(2), ORANGE),
      ],
      existing: [target, mergedSource(sourceHash, target)],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(targetHash);
    expect(rows[0].chargeKey).toBe(targetHash);
    expect(rows[0].occurrenceCount).toBe(4); // 2 Orange + 2 folded-in
    expect(rows[0].merchantLabel).toBe('Orange');
    expect(rows[0].contributingTransactionIds).toContain(4);
  });

  it('folds into a RENAMED target — identity is the stored chargeKey', async () => {
    const sourceHash = hashMerchant('To Orange Espagne S.a.');
    const targetHash = hashMerchant('Orange');
    const target = existingRow({
      id: 1, descriptionHash: targetHash, chargeKey: targetHash,
      merchantLabel: 'My Phone Plan', userLabelLocked: true,
      categoryId: ORANGE.id, cadence: 'MONTHLY', currency: 'USD',
    });
    mockTxns({
      tierA: [
        txn(1, 'Orange', 30, daysAgo(90), ORANGE),
        txn(2, 'Orange', 30, daysAgo(60), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(30), ORANGE),
        txn(4, 'To Orange Espagne S.a.', 30, daysAgo(2), ORANGE),
      ],
      existing: [target, mergedSource(sourceHash, target)],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(targetHash);
    expect(rows[0].occurrenceCount).toBe(4);
    expect(rows[0].merchantLabel).toBe('My Phone Plan');
    expect(rows[0].status).toBe('ACTIVE');
  });

  it('resolves a legacy merge chain (A→B→C, chargeKey never repointed) to the final target', async () => {
    const aHash = hashMerchant('Orange ES old');
    const bHash = hashMerchant('To Orange Espagne S.a.');
    const cHash = hashMerchant('Orange');
    mockTxns({
      tierA: [
        txn(1, 'Orange', 30, daysAgo(60), ORANGE),
        txn(2, 'Orange ES old', 30, daysAgo(30), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(3), ORANGE),
      ],
      existing: [
        existingRow({ id: 1, descriptionHash: cHash, merchantLabel: 'Orange', categoryId: ORANGE.id }),
        existingRow({ id: 2, descriptionHash: aHash, mergedIntoHash: bHash }),
        existingRow({ id: 3, descriptionHash: bHash, mergedIntoHash: cHash }),
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
    const target = existingRow({ id: 1, descriptionHash: targetHash, chargeKey: targetHash });
    const tierA = [];
    let id = 1;
    for (let i = 0; i < 6; i++) {
      tierA.push(txn(id++, 'APPLE.COM/BILL', 2.99, daysAgo(20 + i * 30), ORANGE));
    }
    for (let i = 0; i < 4; i++) {
      tierA.push(txn(id++, 'APPLE ES', 49.99, daysAgo(15 + i * 30), ORANGE));
    }
    mockTxns({ tierA, existing: [target, mergedSource(sourceHash, target)] });
    const { rows, reconciliations } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1); // one combined row, NOT one per band
    expect(rows[0].descriptionHash).toBe(targetHash);
    expect(rows[0].occurrenceCount).toBe(10);
    expect(reconciliations).toEqual([]); // a merged row is never a "split"
  });

  it('folds a merged BAND row into its target on the next run (fixes the band-merge no-op)', async () => {
    const key = normalizeMerchant('APPLE.COM/BILL');
    const band10 = sha256Hex(`${key}#10`); // the €10 band that the user merged away
    const targetHash = hashMerchant('Apple Music');
    const target = existingRow({
      id: 100, descriptionHash: targetHash, chargeKey: targetHash, state: 'CONFIRMED',
      merchantLabel: 'Apple Music', categoryId: ORANGE.id, cadence: 'MONTHLY', currency: 'EUR',
      contributingTransactionIds: [900],
    });
    // The aggregator still splits this run: €3 ×4, €10 ×4, €22 ×3.
    const tierA = [];
    let id = 1;
    for (const [amt, n] of [[2.99, 4], [9.99, 4], [22, 3]]) {
      for (let i = 0; i < n; i++) {
        tierA.push(txn(id++, 'APPLE.COM/BILL', amt, daysAgo(15 + i * 30), ORANGE));
      }
    }
    mockTxns({
      tierA,
      existing: [
        target,
        existingRow({
          id: 101, descriptionHash: band10, chargeKey: targetHash,
          mergedIntoHash: targetHash, merchantLabel: 'APPLE.COM/BILL', currency: 'EUR',
        }),
      ],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'full' });
    const byHash = new Map(rows.map((r) => [r.descriptionHash, r]));
    expect(byHash.has(band10)).toBe(false);       // no standalone €10 band row
    expect(byHash.has(targetHash)).toBe(true);    // it folded into the target
    expect(byHash.get(targetHash).occurrenceCount).toBe(4);
    expect(byHash.get(targetHash).merchantLabel).toBe('Apple Music'); // target label kept
    // the other two bands still detect standalone
    expect(byHash.has(sha256Hex(`${key}#3`))).toBe(true);
    expect(byHash.has(sha256Hex(`${key}#22`))).toBe(true);
  });

  it('folds a confirm-from-transaction row (chargeKey = its own hash) as a merge target', async () => {
    const sourceHash = hashMerchant('SPOT ES');
    const targetHash = hashMerchant('Spotify'); // created by "confirm from a transaction"
    const target = existingRow({
      id: 1, descriptionHash: targetHash, chargeKey: targetHash, state: 'CONFIRMED',
      merchantLabel: 'Spotify', categoryId: ORANGE.id, cadence: 'MONTHLY', currency: 'USD',
      contributingTransactionIds: [50],
    });
    mockTxns({
      tierA: [
        txn(1, 'Spotify', 9.99, daysAgo(60), ORANGE),
        txn(2, 'SPOT ES', 9.99, daysAgo(30), ORANGE),
        txn(3, 'SPOT ES', 9.99, daysAgo(2), ORANGE),
      ],
      existing: [target, mergedSource(sourceHash, target)],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(targetHash);
    expect(rows[0].occurrenceCount).toBe(3);
    expect(rows[0].detectionReason).toBe('USER_CONFIRMED');
  });

  it('synthesizes a target row from folded-in charges when the target has no charges this window', async () => {
    const sourceHash = hashMerchant('To Orange Espagne S.a.');
    const targetHash = hashMerchant('Orange');
    const target = existingRow({
      id: 1, descriptionHash: targetHash, chargeKey: targetHash,
      merchantLabel: 'Orange', categoryId: ORANGE.id, cadence: 'MONTHLY', currency: 'USD',
    });
    mockTxns({
      tierA: [
        txn(1, 'To Orange Espagne S.a.', 30, daysAgo(60), ORANGE),
        txn(2, 'To Orange Espagne S.a.', 30, daysAgo(30), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(3), ORANGE),
      ],
      existing: [target, mergedSource(sourceHash, target)],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(targetHash);
    expect(rows[0].merchantLabel).toBe('Orange');
    expect(rows[0].occurrenceCount).toBe(3);
    expect(rows[0].cadence).toBe('MONTHLY');
  });

  it('a DISMISSED target still suppresses the synthesized row', async () => {
    const sourceHash = hashMerchant('To Orange Espagne S.a.');
    const targetHash = hashMerchant('Orange');
    const target = existingRow({
      id: 1, descriptionHash: targetHash, chargeKey: targetHash, state: 'DISMISSED',
    });
    mockTxns({
      tierA: [
        txn(1, 'To Orange Espagne S.a.', 30, daysAgo(60), ORANGE),
        txn(2, 'To Orange Espagne S.a.', 30, daysAgo(30), ORANGE),
        txn(3, 'To Orange Espagne S.a.', 30, daysAgo(3), ORANGE),
      ],
      existing: [target, mergedSource(sourceHash, target)],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(0);
  });
});

describe('detectForTenant — amount-band reconciliation (no orphaned decisions)', () => {
  const MEDIA = { id: 40, name: 'App Store', icon: '📺', isRecurring: true, type: 'Lifestyle' };

  it('collapses two CONFIRMED bands into one row, keeping the decision, cadence lock and custom label', async () => {
    const key = normalizeMerchant('DAZN');
    const band5 = sha256Hex(`${key}#5`);
    const band10 = sha256Hex(`${key}#10`);
    // This run every charge is ~5.00 — the €10 band aged out, so clusterByAmount
    // yields a single band and the merchant is no longer "split".
    const tierA = Array.from({ length: 6 }, (_, i) =>
      txn(i + 1, 'DAZN', 4.99, daysAgo(10 + i * 30), MEDIA));
    mockTxns({
      tierA,
      existing: [
        existingRow({
          id: 1, descriptionHash: band5, chargeKey: band5, state: 'CONFIRMED',
          cadence: 'MONTHLY', userCadenceLocked: true,
          merchantLabel: 'DAZN Sports', userLabelLocked: true,
          contributingTransactionIds: [1, 2, 3],
        }),
        existingRow({
          id: 2, descriptionHash: band10, chargeKey: band10, state: 'CONFIRMED',
          cadence: 'MONTHLY', contributingTransactionIds: [4, 5, 6],
        }),
      ],
    });
    const { rows, reconciliations } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.descriptionHash).toBe(band5);       // winner = lowest id
    expect(row.chargeKey).toBe(band5);
    expect(row._isConfirmed).toBe(true);
    expect(row.occurrenceCount).toBe(6);
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0].loserId).toBe(2);
    expect(reconciliations[0].winnerDescriptionHash).toBe(band5);
  });

  it('a re-created bare window folds into the CONFIRMED row that already owns its transactions', async () => {
    const key = normalizeMerchant('DAZN');
    const confirmedHash = sha256Hex(`${key}#8`); // an old CONFIRMED band row
    // The 6 newest of the confirmed row's transactions recur this window as a
    // plain (unsplit) series.
    const tierA = Array.from({ length: 6 }, (_, i) =>
      txn(100 + i, 'DAZN', 8.0, daysAgo(5 + i * 30), MEDIA));
    mockTxns({
      tierA,
      existing: [
        existingRow({
          id: 119, descriptionHash: confirmedHash, chargeKey: confirmedHash,
          state: 'CONFIRMED', cadence: 'MONTHLY',
          contributingTransactionIds: [100, 101, 102, 103, 104, 105, 90, 91, 92, 93, 94],
        }),
      ],
    });
    const { rows } = await detectForTenant(TENANT, { mode: 'incremental' });
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptionHash).toBe(confirmedHash); // folded in, no parallel row
    expect(rows[0]._isConfirmed).toBe(true);
  });
});
