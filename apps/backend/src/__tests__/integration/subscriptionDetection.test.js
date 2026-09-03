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
const { hashMerchant } = require('../../services/recurringDetectionService');

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
