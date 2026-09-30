/**
 * Integration test (#92): two manual transaction writes inside the 5 s debounce
 * window must BOTH reach cash holdings and AnalyticsCacheMonthly.
 *
 * Before the fix, `scheduleDebouncedJob` merged only the aggregation key
 * (`needsCashRebuild: [true]`), so the pending `process-cash-holdings` job kept
 * the newest event's `scope` / `originalScope` and the earlier write's month,
 * currency and group were never recomputed.
 *
 * Real: Postgres (bliss_test), Redis (the debounce state), the event scheduler,
 * the cash processor and the analytics worker. Faked: the BullMQ queues (an
 * in-memory stand-in, so no real `portfolio` / `analytics` jobs are touched),
 * the events queue (captured, then fed back to the scheduler by hand) and FX
 * rates (1:1, no external API).
 */

const mockQueues = {};
function mockMakeQueue(name) {
  const jobs = new Map();
  let seq = 0;
  return {
    name,
    jobs,
    add: jest.fn(async (jobName, data) => {
      const id = `${name}-${++seq}`;
      jobs.set(id, { id, name: jobName, data, remove: async () => { jobs.delete(id); } });
      return { id };
    }),
    getJob: jest.fn(async (id) => jobs.get(id) || null),
  };
}

jest.mock('../../queues/portfolioQueue', () => ({
  getPortfolioQueue: () => (mockQueues.portfolio ||= mockMakeQueue('portfolio')),
  fullValuationDedupOpts: () => ({}),
}));
jest.mock('../../queues/analyticsQueue', () => ({
  ANALYTICS_QUEUE_NAME: 'analytics',
  getAnalyticsQueue: () => (mockQueues.analytics ||= mockMakeQueue('analytics')),
}));

const mockEmittedEvents = [];
jest.mock('../../queues/eventsQueue', () => ({
  EVENTS_QUEUE_NAME: 'events',
  enqueueEvent: jest.fn(async (name, data) => { mockEmittedEvents.push({ name, data }); }),
}));

jest.mock('../../services/currencyService', () => {
  const { Decimal } = require('@prisma/client/runtime/library');
  return {
    getRatesForDateRange: jest.fn(async () => new Map()),
    getOrCreateCurrencyRate: jest.fn(async () => new Decimal(1)),
  };
});

const prisma = require('../../../prisma/prisma');
const { initializeRedis, disconnectRedis, getRedisConnection } = require('../../utils/redis');
const { createIsolatedTenant, teardownTenant } = require('../helpers/tenant');
const { ensureReferenceData } = require('../helpers/referenceData');
const { processEventJob } = require('../../workers/eventSchedulerWorker');
const { processCashHoldings } = require('../../workers/portfolio-handlers/cash-processor');
const { processAnalyticsJob } = require('../../workers/analyticsWorker');

const takeOnlyJob = (queue, jobName) => {
  const jobs = [...queue.jobs.values()].filter((j) => j.name === jobName);
  expect(jobs).toHaveLength(1); // debounced: the earlier job was replaced, not duplicated
  queue.jobs.delete(jobs[0].id);
  return jobs[0];
};

const takeEvent = (name) => {
  const idx = mockEmittedEvents.findIndex((e) => e.name === name);
  expect(idx).toBeGreaterThanOrEqual(0);
  return mockEmittedEvents.splice(idx, 1)[0];
};

describe('debounced cash/analytics jobs keep every event scope (#92)', () => {
  let tenantId;
  let usdAccount;
  let eurAccount;
  let groceries;
  let dining;

  beforeAll(async () => {
    await initializeRedis();
    const ref = await ensureReferenceData({ countryId: 'USA', currencyCode: 'USD' });
    await ensureReferenceData({ countryId: 'USA', currencyCode: 'EUR' });
    ({ tenantId } = await createIsolatedTenant({ suffix: 'debounce-merge' }));

    await prisma.tenantCurrency.create({ data: { tenantId, currencyId: 'USD', isDefault: true } });
    await prisma.tenantCurrency.create({ data: { tenantId, currencyId: 'EUR' } });
    await prisma.category.create({
      data: { tenantId, name: 'Cash', group: 'Cash', type: 'Asset', processingHint: 'CASH' },
    });
    groceries = await prisma.category.create({ data: { tenantId, name: 'Groceries', group: 'Food', type: 'Essentials' } });
    dining = await prisma.category.create({ data: { tenantId, name: 'Restaurants', group: 'Dining', type: 'Lifestyle' } });

    const account = (currencyCode) => prisma.account.create({
      data: {
        tenantId,
        name: `Acct ${currencyCode}`,
        accountNumber: `DEB-${currencyCode}-${Date.now()}`,
        bankId: ref.bankId,
        countryId: ref.countryId,
        currencyCode,
      },
    });
    usdAccount = await account('USD');
    eurAccount = await account('EUR');
  });

  afterAll(async () => {
    await getRedisConnection().del(
      `debounce:process-cash-holdings:tenant:${tenantId}`,
      `debounce:scoped-update-analytics:tenant:${tenantId}`,
    );
    await prisma.portfolioHolding.deleteMany({ where: { asset: { tenantId } } });
    await prisma.portfolioItem.deleteMany({ where: { tenantId } });
    await prisma.analyticsCacheMonthly.deleteMany({ where: { tenantId } });
    await prisma.tagAnalyticsCacheMonthly.deleteMany({ where: { tenantId } });
    await prisma.tenantCurrency.deleteMany({ where: { tenantId } });
    await teardownTenant(tenantId);
    await disconnectRedis();
  });

  it('two creates within the window (different month, currency, account, group) are both reflected', async () => {
    const create = async ({ date, account, category, debit }) => {
      const d = new Date(`${date}T12:00:00Z`);
      const tx = await prisma.transaction.create({
        data: {
          tenantId,
          transaction_date: d,
          year: d.getUTCFullYear(),
          quarter: `Q${Math.floor(d.getUTCMonth() / 3) + 1}`,
          month: d.getUTCMonth() + 1,
          day: d.getUTCDate(),
          description: `${category.name} purchase`,
          debit,
          currency: account.currencyCode,
          accountId: account.id,
          categoryId: category.id,
          source: 'MANUAL',
        },
      });
      // Same payload the API route sends for a manual create.
      await processEventJob({
        id: `evt-${tx.id}`,
        name: 'MANUAL_TRANSACTION_CREATED',
        data: {
          tenantId,
          transactionId: tx.id,
          categoryType: category.type,
          categoryGroup: category.group,
          transaction_date: d.toISOString(),
          currency: account.currencyCode,
          country: 'USA',
        },
      });
    };

    // A July USD grocery, then an August EUR dinner, inside one debounce window.
    await create({ date: '2026-07-10', account: usdAccount, category: groceries, debit: 42 });
    await create({ date: '2026-08-15', account: eurAccount, category: dining, debit: 30 });

    // 1. One pending cash job, carrying the union of both scopes.
    const cashJob = takeOnlyJob(mockQueues.portfolio, 'process-cash-holdings');
    expect(cashJob.data.scope).toEqual({ year: 2026 }); // USD ∪ EUR → all currencies
    expect(cashJob.data.originalScope.earliestDate).toBe('2026-07-01');

    // 2. Run it the way portfolioWorker does (scope enriched with originalScope).
    const { scope, originalScope, portfolioItemIds } = cashJob.data;
    await processCashHoldings(tenantId, {
      ...scope,
      ...(originalScope !== undefined && { originalScope }),
      ...(portfolioItemIds !== undefined && { portfolioItemIds }),
    });

    const cashItems = await prisma.portfolioItem.findMany({
      where: { tenantId, category: { processingHint: 'CASH' } },
      include: { holdings: true },
    });
    const byCurrency = Object.fromEntries(cashItems.map((i) => [i.currency, i]));
    expect(Object.keys(byCurrency).sort()).toEqual(['EUR', 'USD']);
    expect(byCurrency.USD.holdings.map((h) => Number(h.quantity))).toEqual([-42]);
    expect(byCurrency.EUR.holdings.map((h) => Number(h.quantity))).toEqual([-30]);

    // 3. CASH_HOLDINGS_PROCESSED → scoped analytics, then run the analytics job.
    await processEventJob({ id: 'evt-cash', name: 'CASH_HOLDINGS_PROCESSED', data: takeEvent('CASH_HOLDINGS_PROCESSED').data });
    const analyticsJob = takeOnlyJob(mockQueues.analytics, 'scoped-update-analytics');
    await processAnalyticsJob({ id: analyticsJob.id, name: analyticsJob.name, data: analyticsJob.data, updateProgress: async () => {} });

    const rows = await prisma.analyticsCacheMonthly.findMany({
      where: { tenantId },
      select: { year: true, month: true, currency: true, type: true, group: true, debit: true },
      orderBy: [{ month: 'asc' }],
    });
    const july = rows.filter((r) => r.month === 7);
    const august = rows.filter((r) => r.month === 8);
    expect(july.length).toBeGreaterThan(0);
    expect(august.length).toBeGreaterThan(0);
    expect(july.every((r) => r.type === 'Essentials' && r.group === 'Food')).toBe(true);
    expect(august.every((r) => r.type === 'Lifestyle' && r.group === 'Dining')).toBe(true);
    expect(july.some((r) => r.currency === 'USD' && Number(r.debit) === 42)).toBe(true);
    expect(august.some((r) => r.currency === 'EUR' && Number(r.debit) === 30)).toBe(true);
  });
});
