/**
 * Unit tests for `processAnalyticsJob` — specifically the write path that
 * replaced the old per-row upsert pattern.
 *
 * Two code paths to verify:
 *
 *   1. Full rebuild (`full-rebuild-analytics`, or `recalculate-analytics`
 *      with no scope):
 *        - Wipes tenant's existing rows via a $transaction(deleteMany +
 *          deleteMany).
 *        - Writes new rows via plain createMany() per batch.
 *        - Crucially: does NOT pass `skipDuplicates` — unique violations
 *          surface as errors rather than silently discarding rows (see
 *          commit "perf(backend): replace analyticsWorker N+1 upserts").
 *
 *   2. Scoped update (`scoped-update-analytics`, or `recalculate-analytics`
 *      with a non-empty scope):
 *        - Does NOT wipe the tenant's rows.
 *        - Per batch: atomic $transaction([deleteMany-by-composite-key,
 *          createMany]) so existing rows for the same composite keys are
 *          replaced in place without losing untouched periods.
 *        - Delete-safety: when the recompute yields NOTHING for the job
 *          (every fed transaction is gone), the per-batch replace can't
 *          run, so the job clears each scope's cache rows by
 *          date-range/type/group/country (currency is not constrained —
 *          scope currency is native, cache currency is display). Skipped
 *          when a scope is unbounded, so the tenant is never wiped.
 *
 * These invariants aren't visible from `calculateAnalytics`'s own tests
 * (which only cover the pure compute step). Without this file a regression
 * to per-row upserts or a missing tenant-wipe on full rebuild would ship
 * silently.
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
  enqueueEvent: jest.fn().mockResolvedValue(undefined),
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

// Prisma mock — each test installs its own per-call queue for `findMany`.
// Everything else returns simple truthy values; we assert on the mock
// call log rather than return-value shape.
jest.mock('../../../../prisma/prisma.js', () => ({
  transaction: {
    findMany: jest.fn(),
  },
  tenantCurrency: {
    findMany: jest.fn().mockResolvedValue([{ currencyId: 'USD' }]),
  },
  analyticsCacheMonthly: {
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  tagAnalyticsCacheMonthly: {
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  // `$transaction` is passed an array of *deferred* query objects in this
  // codebase. We don't actually execute them — we just verify the array
  // shape and resolve.
  $transaction: jest.fn().mockResolvedValue([]),
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

const prisma = require('../../../../prisma/prisma.js');
const { processAnalyticsJob } = require('../../../workers/analyticsWorker');

// ─── Helpers ────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-write-path';

/**
 * Build a minimal transaction shape that `calculateAnalytics` will accept.
 * The two passes select different fields; we provide both by unioning.
 */
function makeTxn(overrides = {}) {
  const base = {
    id: 1,
    year: 2026,
    month: 3,
    transaction_date: new Date('2026-03-15'),
    currency: 'USD',
    credit: 0,
    debit: 100,
    account: { countryId: 'US' },
    category: { id: 10, name: 'Coffee', type: 'Expense', group: 'Dining' },
    tags: [],
  };
  return { ...base, ...overrides };
}

/**
 * Install a findMany mock queue that covers both Pass 1 (date discovery)
 * and Pass 2 (full classification) of `calculateAnalytics`:
 *
 *   - Pass 1 batch 1: `transactions`
 *   - Pass 1 batch 2: [] (terminates)
 *   - Pass 2 batch 1: `transactions`
 *   - Pass 2 batch 2: [] (terminates)
 *
 * Pass `transactions = []` to simulate a tenant with no rows.
 */
function queueFindMany(transactions) {
  prisma.transaction.findMany
    .mockResolvedValueOnce(transactions) // Pass 1 batch 1
    .mockResolvedValueOnce([])           // Pass 1 end
    .mockResolvedValueOnce(transactions) // Pass 2 batch 1
    .mockResolvedValueOnce([]);          // Pass 2 end
}

function makeJob(name, data, { id = 'job-1' } = {}) {
  return {
    id,
    name,
    data,
    updateProgress: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('processAnalyticsJob — write path', () => {
  beforeEach(() => {
    // `jest.clearAllMocks()` clears mock.calls but leaves the
    // `mockResolvedValueOnce` queue intact — values queued by one test
    // then leak into the next. `mockReset()` clears both.
    prisma.transaction.findMany.mockReset();
    prisma.tenantCurrency.findMany.mockReset();
    prisma.analyticsCacheMonthly.deleteMany.mockReset();
    prisma.analyticsCacheMonthly.createMany.mockReset();
    prisma.tagAnalyticsCacheMonthly.deleteMany.mockReset();
    prisma.tagAnalyticsCacheMonthly.createMany.mockReset();
    prisma.$transaction.mockReset();

    // Re-install defaults after reset.
    prisma.tenantCurrency.findMany.mockResolvedValue([{ currencyId: 'USD' }]);
    prisma.analyticsCacheMonthly.deleteMany.mockResolvedValue({ count: 0 });
    prisma.analyticsCacheMonthly.createMany.mockResolvedValue({ count: 0 });
    prisma.tagAnalyticsCacheMonthly.deleteMany.mockResolvedValue({ count: 0 });
    prisma.tagAnalyticsCacheMonthly.createMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockResolvedValue([]);
  });

  describe('full rebuild path', () => {
    it('wipes tenant rows via $transaction, then createMany per batch with NO skipDuplicates', async () => {
      queueFindMany([makeTxn()]);

      await processAnalyticsJob(makeJob('full-rebuild-analytics', {
        tenantId: TENANT_ID,
      }));

      // 1. The outer tenant-wide wipe runs first as a $transaction of two
      //    deleteMany calls (analytics + tag analytics).
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const wipeCall = prisma.$transaction.mock.calls[0][0];
      expect(Array.isArray(wipeCall)).toBe(true);
      expect(wipeCall).toHaveLength(2);

      // 2. createMany runs for the actual writes — one batch since we had
      //    a single analytics entry.
      expect(prisma.analyticsCacheMonthly.createMany).toHaveBeenCalledTimes(1);
      const createCall = prisma.analyticsCacheMonthly.createMany.mock.calls[0][0];
      expect(createCall).toHaveProperty('data');
      expect(createCall.data).toHaveLength(1);
      expect(createCall.data[0]).toMatchObject({
        tenantId: TENANT_ID,
        year: 2026,
        month: 3,
        currency: 'USD',
        country: 'US',
        type: 'Expense',
        group: 'Dining',
      });
      // The critical invariant: no `skipDuplicates` — unique violations
      // must surface as errors, not be silently swallowed.
      expect(createCall.skipDuplicates).toBeUndefined();

      // 3. deleteMany is called exactly once — for the outer tenant-wide
      //    wipe that feeds the $transaction above. It is NOT called
      //    per-batch on the full-rebuild path. (The scoped path is where
      //    per-batch deleteMany-by-composite-key lives — covered below.)
      expect(prisma.analyticsCacheMonthly.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.analyticsCacheMonthly.deleteMany.mock.calls[0][0]).toEqual({
        where: { tenantId: TENANT_ID },
      });
    });

    it('full rebuild with no transactions still wipes but does not createMany', async () => {
      queueFindMany([]);

      await processAnalyticsJob(makeJob('full-rebuild-analytics', {
        tenantId: TENANT_ID,
      }));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.analyticsCacheMonthly.createMany).not.toHaveBeenCalled();
      expect(prisma.tagAnalyticsCacheMonthly.createMany).not.toHaveBeenCalled();
    });

    it('recalculate-analytics with no scope is treated as a full rebuild', async () => {
      queueFindMany([makeTxn()]);

      await processAnalyticsJob(makeJob('recalculate-analytics', {
        tenantId: TENANT_ID,
      }));

      // Same invariants: tenant wipe + plain createMany (no skipDuplicates).
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.analyticsCacheMonthly.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.analyticsCacheMonthly.createMany.mock.calls[0][0].skipDuplicates)
        .toBeUndefined();
    });

    it('includes tag analytics write when transactions have tags', async () => {
      queueFindMany([makeTxn({ tags: [{ tagId: 42 }] })]);

      await processAnalyticsJob(makeJob('full-rebuild-analytics', {
        tenantId: TENANT_ID,
      }));

      expect(prisma.tagAnalyticsCacheMonthly.createMany).toHaveBeenCalledTimes(1);
      const tagCall = prisma.tagAnalyticsCacheMonthly.createMany.mock.calls[0][0];
      expect(tagCall.data).toHaveLength(1);
      expect(tagCall.data[0]).toMatchObject({
        tenantId: TENANT_ID,
        tagId: 42,
        categoryId: 10,
        year: 2026,
        month: 3,
        currency: 'USD',
        country: 'US',
        type: 'Expense',
        group: 'Dining',
      });
      expect(tagCall.skipDuplicates).toBeUndefined();
    });
  });

  describe('scoped update path', () => {
    it('when the recompute produces rows, only the per-batch $transaction(deleteMany-by-key + createMany) runs', async () => {
      queueFindMany([makeTxn()]);

      await processAnalyticsJob(makeJob('scoped-update-analytics', {
        tenantId: TENANT_ID,
        scopes: [{ year: 2026, month: 3 }],
      }));

      // Recompute yielded a row → the delete-safety scope clear is NOT
      // triggered; only the per-batch replace happens.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2); // [deleteMany, createMany]

      expect(prisma.analyticsCacheMonthly.deleteMany).toHaveBeenCalledTimes(1);
      const deleteCall = prisma.analyticsCacheMonthly.deleteMany.mock.calls[0][0];
      expect(deleteCall.where.tenantId).toBe(TENANT_ID);
      expect(deleteCall.where.OR).toHaveLength(1);
      expect(deleteCall.where.OR[0]).toEqual({
        year: 2026,
        month: 3,
        currency: 'USD',
        country: 'US',
        type: 'Expense',
        group: 'Dining',
      });

      expect(prisma.analyticsCacheMonthly.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.analyticsCacheMonthly.createMany.mock.calls[0][0].skipDuplicates)
        .toBeUndefined();
    });

    it('scoped update with tagged transactions uses the 9-column composite key for the tag table', async () => {
      queueFindMany([makeTxn({ tags: [{ tagId: 42 }] })]);

      await processAnalyticsJob(makeJob('scoped-update-analytics', {
        tenantId: TENANT_ID,
        scopes: [{ year: 2026, month: 3 }],
      }));

      // Two per-batch $transaction calls: one for analytics, one for tag analytics.
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);

      expect(prisma.tagAnalyticsCacheMonthly.deleteMany).toHaveBeenCalledTimes(1);
      const tagDeleteCall = prisma.tagAnalyticsCacheMonthly.deleteMany.mock.calls[0][0];
      expect(tagDeleteCall.where.tenantId).toBe(TENANT_ID);
      expect(tagDeleteCall.where.OR[0]).toEqual({
        tagId: 42,
        year: 2026,
        month: 3,
        currency: 'USD',
        country: 'US',
        type: 'Expense',
        group: 'Dining',
        categoryId: 10,
      });
    });

    it('when the recompute yields nothing, clears the scope cache rows (delete-safety)', async () => {
      queueFindMany([]);

      await processAnalyticsJob(makeJob('scoped-update-analytics', {
        tenantId: TENANT_ID,
        scopes: [{ year: 2026, month: 3 }],
      }));

      // The last transaction in the slice is gone: the per-batch replace has
      // nothing to write, so the scope clear removes the now-stale row.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2); // [analytics.deleteMany, tag.deleteMany]
      expect(prisma.analyticsCacheMonthly.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.analyticsCacheMonthly.deleteMany.mock.calls[0][0]).toEqual({
        where: { tenantId: TENANT_ID, year: 2026, month: 3 },
      });
      expect(prisma.tagAnalyticsCacheMonthly.deleteMany).toHaveBeenCalledTimes(1);

      // Nothing survived, so nothing is re-inserted.
      expect(prisma.analyticsCacheMonthly.createMany).not.toHaveBeenCalled();
      expect(prisma.tagAnalyticsCacheMonthly.createMany).not.toHaveBeenCalled();
    });

    it('clears the deleted slice from a consolidated scope, ignoring native currency (regression)', async () => {
      // The event scheduler turns a deletion into { earliestDate, filters }.
      // filters.currency is the transaction's NATIVE currency; cache rows are
      // keyed by the tenant's DISPLAY currency — so the clear must not filter
      // on currency, or it silently matches nothing (the bug this guards).
      queueFindMany([]);

      await processAnalyticsJob(makeJob('scoped-update-analytics', {
        tenantId: TENANT_ID,
        scopes: [{
          earliestDate: '2026-03-01',
          filters: {
            type: ['Growth'],
            group: ['Donations'],
            currency: ['EUR'],
            country: ['DEU'],
          },
        }],
      }));

      expect(prisma.analyticsCacheMonthly.deleteMany).toHaveBeenCalledTimes(1);
      const where = prisma.analyticsCacheMonthly.deleteMany.mock.calls[0][0].where;
      expect(where.tenantId).toBe(TENANT_ID);
      expect(where.OR).toEqual([{ year: { gt: 2026 } }, { year: 2026, month: { gte: 3 } }]);
      expect(where.type).toEqual({ in: ['Growth'] });
      expect(where.group).toEqual({ in: ['Donations'] });
      expect(where.country).toEqual({ in: ['DEU'] });
      expect(where.currency).toBeUndefined();
      expect(prisma.analyticsCacheMonthly.createMany).not.toHaveBeenCalled();
    });

    it('never wipes the whole tenant when a scope has no date bound and no filters', async () => {
      queueFindMany([]);

      await processAnalyticsJob(makeJob('scoped-update-analytics', {
        tenantId: TENANT_ID,
        scopes: [{}],
      }));

      // scopeToCacheWhere() returns null → the scope clear is skipped entirely.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.analyticsCacheMonthly.deleteMany).not.toHaveBeenCalled();
      expect(prisma.tagAnalyticsCacheMonthly.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('tenant with no currencies', () => {
    it('skips entirely without touching the analytics tables', async () => {
      prisma.tenantCurrency.findMany.mockResolvedValueOnce([]);

      const result = await processAnalyticsJob(makeJob('full-rebuild-analytics', {
        tenantId: TENANT_ID,
      }));

      expect(result).toEqual({ success: true, message: 'No currencies for tenant.' });
      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.analyticsCacheMonthly.createMany).not.toHaveBeenCalled();
    });
  });
});
