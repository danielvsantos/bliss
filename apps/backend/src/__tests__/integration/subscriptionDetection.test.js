/**
 * Integration tests for the subscription-detection worker.
 *
 * Runs the real `handleDetectTenant` against the bliss_test Postgres database:
 * seeds a tenant with categories + accounts + committed transactions, runs
 * detection, and asserts the persisted RecurringCharge rows.
 *
 * Requires: bliss_test Postgres database with migrations applied.
 */

const prisma = require('../../../prisma/prisma');
const { createIsolatedTenant, teardownTenant } = require('../helpers/tenant');
const { ensureReferenceData } = require('../helpers/referenceData');
const { handleDetectTenant } = require('../../workers/subscriptionDetectionWorker');
const { hashMerchant, sha256Hex, normalizeMerchant } = require('../../services/recurringDetectionService');

// Populated in beforeAll — CI's bliss_test has no seeded Country/Currency/Bank.
let ref;

function ymd(date) {
  const d = new Date(date);
  const q = `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return { year: d.getUTCFullYear(), quarter: q, month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

async function seedAccount(tenantId, currency = 'USD') {
  return prisma.account.create({
    data: {
      name: `Acct ${currency}`,
      accountNumber: `TEST-${currency}-${Date.now()}${Math.floor(Math.random() * 1000)}`,
      bankId: ref.bankId,
      countryId: ref.countryId,
      currencyCode: currency,
      tenantId,
    },
  });
}

async function seedCategory(tenantId, name, isRecurring, type = 'Lifestyle') {
  return prisma.category.create({
    data: { name, group: 'Test', type, tenantId, isRecurring },
  });
}

async function seedTxn(tenantId, { accountId, categoryId, description, debit, date, currency = 'USD', source = 'PLAID' }) {
  return prisma.transaction.create({
    data: {
      ...ymd(date),
      transaction_date: date,
      description,
      debit,
      currency,
      accountId,
      categoryId,
      tenantId,
      source,
    },
  });
}

describe('subscription detection (integration)', () => {
  let tenantId;
  let accountUSD;
  let recurringCat;
  let spendingCat;

  beforeAll(async () => {
    ref = await ensureReferenceData();
    ({ tenantId } = await createIsolatedTenant({ suffix: 'subsdetect' }));
    accountUSD = await seedAccount(tenantId, 'USD');
    recurringCat = await seedCategory(tenantId, 'Content & Media', true);
    spendingCat = await seedCategory(tenantId, 'Sports & Gym', false);
  });

  afterAll(async () => {
    await prisma.recurringCharge.deleteMany({ where: { tenantId } });
    await teardownTenant(tenantId);
  });

  it('Tier A: a single charge in a recurring category is detected', async () => {
    await seedTxn(tenantId, {
      accountId: accountUSD.id,
      categoryId: recurringCat.id,
      description: 'NETFLIX.COM',
      debit: 15.99,
      date: daysAgo(4),
      source: 'PLAID',
    });

    await handleDetectTenant({ tenantId, mode: 'incremental' });

    const row = await prisma.recurringCharge.findUnique({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: hashMerchant('NETFLIX.COM') } },
    });
    expect(row).toBeTruthy();
    expect(row.detectionReason).toBe('CATEGORY_SIGNAL');
    expect(row.state).toBe('DETECTED');
    expect(row.occurrenceCount).toBe(1);
    expect(row.merchantLabel).toBe('NETFLIX.COM'); // decrypted transparently
  });

  it('Tier B: 3 regular gym charges are detected as MONTHLY', async () => {
    for (const n of [92, 61, 30]) {
      await seedTxn(tenantId, {
        accountId: accountUSD.id,
        categoryId: spendingCat.id,
        description: 'CITY GYM MEMBERSHIP',
        debit: 39.99,
        date: daysAgo(n),
        source: 'CSV',
      });
    }

    await handleDetectTenant({ tenantId, mode: 'incremental' });

    const row = await prisma.recurringCharge.findUnique({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: hashMerchant('CITY GYM MEMBERSHIP') } },
    });
    expect(row).toBeTruthy();
    expect(row.detectionReason).toBe('INTERVAL_HEURISTIC');
    expect(row.cadence).toBe('MONTHLY');
    expect(row.occurrenceCount).toBe(3);
  });

  it('CSV and Plaid transactions are detected identically', async () => {
    const csvCat = await seedCategory(tenantId, 'CSV Media', true);
    await seedTxn(tenantId, {
      accountId: accountUSD.id,
      categoryId: csvCat.id,
      description: 'SPOTIFY VIA CSV',
      debit: 9.99,
      date: daysAgo(2),
      source: 'CSV',
    });
    await handleDetectTenant({ tenantId, mode: 'incremental' });
    const row = await prisma.recurringCharge.findUnique({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: hashMerchant('SPOTIFY VIA CSV') } },
    });
    expect(row).toBeTruthy();
    expect(row.detectionReason).toBe('CATEGORY_SIGNAL');
  });

  it('a DISMISSED merchant is not re-surfaced', async () => {
    const hash = hashMerchant('CITY GYM MEMBERSHIP');
    await prisma.recurringCharge.update({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: hash } },
      data: { state: 'DISMISSED' },
    });

    await handleDetectTenant({ tenantId, mode: 'incremental' });

    const row = await prisma.recurringCharge.findUnique({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: hash } },
    });
    expect(row.state).toBe('DISMISSED'); // tombstone preserved, not re-detected
  });

  it('full mode stamps Tenant.subscriptionsFullScanAt', async () => {
    await handleDetectTenant({ tenantId, mode: 'full' });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { subscriptionsFullScanAt: true } });
    expect(tenant.subscriptionsFullScanAt).toBeInstanceOf(Date);
  });

  it('multi-tenant isolation: another tenant with the same merchant sees only its own row', async () => {
    const { tenantId: otherTenant } = await createIsolatedTenant({ suffix: 'subsdetect-b' });
    try {
      const acct = await seedAccount(otherTenant, 'USD');
      const cat = await seedCategory(otherTenant, 'Content & Media', true);
      await seedTxn(otherTenant, {
        accountId: acct.id,
        categoryId: cat.id,
        description: 'NETFLIX.COM',
        debit: 15.99,
        date: daysAgo(3),
      });
      await handleDetectTenant({ tenantId: otherTenant, mode: 'incremental' });

      const mine = await prisma.recurringCharge.count({ where: { tenantId } });
      const theirs = await prisma.recurringCharge.count({ where: { tenantId: otherTenant } });
      expect(mine).toBeGreaterThan(0);
      expect(theirs).toBe(1);
    } finally {
      await prisma.recurringCharge.deleteMany({ where: { tenantId: otherTenant } });
      await teardownTenant(otherTenant);
    }
  });
});

describe('subscription detection — aggregator merchant splitting (integration)', () => {
  let tenantId;
  let account;
  let mediaCat;

  beforeAll(async () => {
    ref = await ensureReferenceData();
    ({ tenantId } = await createIsolatedTenant({ suffix: 'subsdetect-split' }));
    account = await seedAccount(tenantId, 'USD');
    mediaCat = await seedCategory(tenantId, 'App Store', true);

    // €2.99 ×4 monthly, €9.99 ×4 monthly, one $39.99 purchase — all "APPLE.COM/BILL".
    for (const [amt, count] of [[2.99, 4], [9.99, 4]]) {
      for (let i = 0; i < count; i++) {
        await seedTxn(tenantId, {
          accountId: account.id, categoryId: mediaCat.id,
          description: 'APPLE.COM/BILL', debit: amt, date: daysAgo(15 + i * 30),
        });
      }
    }
    await seedTxn(tenantId, {
      accountId: account.id, categoryId: mediaCat.id,
      description: 'APPLE.COM/BILL', debit: 39.99, date: daysAgo(20),
    });
  });

  afterAll(async () => {
    await prisma.recurringCharge.deleteMany({ where: { tenantId } });
    await teardownTenant(tenantId);
  });

  it('splits one busy merchant into per-price rows and retires the legacy combined row', async () => {
    const key = normalizeMerchant('APPLE.COM/BILL');

    // Simulate the pre-clustering world: a single combined row the user confirmed.
    await prisma.recurringCharge.create({
      data: {
        tenantId, descriptionHash: sha256Hex(key), merchantLabel: 'APPLE.COM/BILL',
        categoryId: mediaCat.id, state: 'CONFIRMED', cadence: 'WEEKLY', status: 'ACTIVE',
        amount: 9.99, currency: 'USD', occurrenceCount: 9, lastChargedAt: daysAgo(15),
        contributingTransactionIds: [],
      },
    });

    await handleDetectTenant({ tenantId, mode: 'full' });

    const rows = await prisma.recurringCharge.findMany({ where: { tenantId }, orderBy: { amount: 'asc' } });
    // Two price bands (€2.99, €9.99); the lone €39.99 forms no band.
    expect(rows.map((r) => Number(r.amount))).toEqual([2.99, 9.99]);
    expect(rows.every((r) => r.state === 'DETECTED')).toBe(true);

    // The legacy combined row (bare merchant hash) is gone.
    const legacy = await prisma.recurringCharge.findUnique({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: sha256Hex(key) } },
    });
    expect(legacy).toBeNull();

    // A second run is stable (still two rows, still no legacy row).
    await handleDetectTenant({ tenantId, mode: 'full' });
    const again = await prisma.recurringCharge.count({ where: { tenantId } });
    expect(again).toBe(2);
  });
});

describe('subscription detection — manual merge + rename (integration)', () => {
  let tenantId;
  let account;
  let telecomCat;
  const SRC = 'To Orange Espagne S.a.';
  const TGT = 'Orange';

  beforeAll(async () => {
    ref = await ensureReferenceData();
    ({ tenantId } = await createIsolatedTenant({ suffix: 'subsdetect-merge' }));
    account = await seedAccount(tenantId, 'USD');
    telecomCat = await seedCategory(tenantId, 'Telecom', true, 'Essentials');

    // "Orange" ×2 older, "To Orange Espagne S.a." ×2 recent — same real service.
    for (const n of [120, 90]) {
      await seedTxn(tenantId, { accountId: account.id, categoryId: telecomCat.id, description: TGT, debit: 30, date: daysAgo(n) });
    }
    for (const n of [30, 2]) {
      await seedTxn(tenantId, { accountId: account.id, categoryId: telecomCat.id, description: SRC, debit: 30, date: daysAgo(n) });
    }
  });

  afterAll(async () => {
    await prisma.recurringCharge.deleteMany({ where: { tenantId } });
    await teardownTenant(tenantId);
  });

  it('folds a merged merchant into its target — even when the target was renamed first', async () => {
    const srcHash = hashMerchant(SRC);
    const tgtHash = hashMerchant(TGT);

    // 1. First run — two independent rows.
    await handleDetectTenant({ tenantId, mode: 'incremental' });
    let src = await prisma.recurringCharge.findUnique({ where: { tenantId_descriptionHash: { tenantId, descriptionHash: srcHash } } });
    let tgt = await prisma.recurringCharge.findUnique({ where: { tenantId_descriptionHash: { tenantId, descriptionHash: tgtHash } } });
    expect(src).toBeTruthy();
    expect(tgt).toBeTruthy();
    expect(tgt.occurrenceCount).toBe(2);

    // 2. User renames the target FIRST (the case that broke merge before) …
    await prisma.recurringCharge.update({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: tgtHash } },
      data: { merchantLabel: 'Orange Spain (home)', userLabelLocked: true },
    });

    // 3. … then merges src → tgt. POST /api/subscriptions?action=merge stores the
    //    target ROW's descriptionHash — unaffected by the rename.
    await prisma.recurringCharge.update({
      where: { tenantId_descriptionHash: { tenantId, descriptionHash: srcHash } },
      data: { mergedIntoHash: tgtHash, nextExpectedAt: null, contributingTransactionIds: [] },
    });

    await handleDetectTenant({ tenantId, mode: 'incremental' });

    src = await prisma.recurringCharge.findUnique({ where: { tenantId_descriptionHash: { tenantId, descriptionHash: srcHash } } });
    tgt = await prisma.recurringCharge.findUnique({ where: { tenantId_descriptionHash: { tenantId, descriptionHash: tgtHash } } });
    expect(src).toBeTruthy();                    // tombstone NOT pruned
    expect(src.mergedIntoHash).toBe(tgtHash);
    expect(tgt.occurrenceCount).toBe(4);         // 2 renamed-target + 2 folded-in — no phantom row
    expect(tgt.merchantLabel).toBe('Orange Spain (home)'); // custom name kept across the run

    // No phantom lapsed row spun up under the source descriptor.
    const all = await prisma.recurringCharge.findMany({ where: { tenantId } });
    expect(all).toHaveLength(2); // just the target + the source tombstone

    // 4. Unmerge — the source is detected standalone again.
    await prisma.recurringCharge.updateMany({
      where: { tenantId, descriptionHash: srcHash, mergedIntoHash: { not: null } },
      data: { mergedIntoHash: null },
    });
    await handleDetectTenant({ tenantId, mode: 'incremental' });
    src = await prisma.recurringCharge.findUnique({ where: { tenantId_descriptionHash: { tenantId, descriptionHash: srcHash } } });
    tgt = await prisma.recurringCharge.findUnique({ where: { tenantId_descriptionHash: { tenantId, descriptionHash: tgtHash } } });
    expect(src.mergedIntoHash).toBeNull();
    expect(src.occurrenceCount).toBe(2);
    expect(tgt.occurrenceCount).toBe(2); // folded-in charges released
  });
});
