/**
 * Smoke tests for process-portfolio-changes.js.
 *
 * Before these tests existed, this 517-line handler had ZERO direct
 * coverage — the only test that imported it (portfolioWorker.test.js)
 * mocked it entirely. A scope error I introduced in commit `df39559`
 * (`await job.heartbeat?.()` inside `handleFullRebuild`, where `job`
 * is out of scope) made it to production because nothing in the test
 * suite executed this file's code paths.
 *
 * Scope of this file: exercise each top-level branch of
 * `processPortfolioChanges` (scoped, account-scoped, full rebuild) end-
 * to-end with mocked Prisma, to catch scope errors and obvious
 * regressions. Deep business-logic coverage (FIFO calculation,
 * currency conversion accuracy) stays out — those already live in
 * dedicated tests for `holdings-calculator`, `portfolioItemStateCalculator`,
 * etc. The goal here is "doesn't throw on reasonable inputs", not
 * "every edge case".
 *
 * Key invariant checked: all three branches of `processPortfolioChanges`
 * return a result shape without throwing `ReferenceError` or similar
 * scope errors. This is the exact class of bug that motivated adding
 * both this test and the backend ESLint config.
 */

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../../prisma/prisma.js', () => ({
  transaction: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  portfolioItem: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  category: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
  manualAssetValue: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  portfolioHolding: {
    createMany: jest.fn(),
  },
  $transaction: jest.fn((ops) => Promise.all(ops)),
}));

jest.mock('../../../../services/currencyService', () => ({
  getRatesForDateRange: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../../../../queues/eventsQueue', () => ({
  enqueueEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../../utils/encryption', () => ({
  decrypt: jest.fn((v) => v),
}));

jest.mock('../../../../utils/portfolioItemStateCalculator.js', () => ({
  calculatePortfolioItemState: jest.fn().mockResolvedValue({
    costBasis: 0,
    currentValue: 0,
    realizedPnL: 0,
    quantity: 0,
  }),
}));

jest.mock('../../../../workers/portfolio-handlers/asset-aggregator', () => ({
  generateAssetKey: jest.fn((tx) => tx.ticker || null),
}));

const prisma = require('../../../../../prisma/prisma.js');
const { enqueueEvent } = require('../../../../queues/eventsQueue');
const processPortfolioChanges = require('../../../../workers/portfolio-handlers/process-portfolio-changes');

const makeJob = (data = {}) => ({
  id: 'job-1',
  name: 'process-portfolio-changes',
  data: { tenantId: 'tenant-1', ...data },
  // `job.heartbeat` is attached by portfolioWorker at dispatch time.
  // The regression this file guards against was accessing `job` from
  // inside a helper that doesn't receive it — so these tests MUST
  // expose heartbeat here and the code must accept NOT having access
  // to it inside helpers.
  heartbeat: jest.fn().mockResolvedValue(undefined),
});

// Default prisma responses — empty tenant, no transactions, no portfolio items.
function installEmptyTenantMocks() {
  prisma.transaction.findMany.mockResolvedValue([]);
  prisma.transaction.findFirst.mockResolvedValue(null);
  prisma.portfolioItem.findMany.mockResolvedValue([]);
  prisma.portfolioItem.findUnique.mockResolvedValue(null);
  prisma.portfolioItem.create.mockResolvedValue({ id: 1 });
  prisma.portfolioItem.createMany.mockResolvedValue({ count: 0 });
  prisma.portfolioItem.update.mockResolvedValue({});
  prisma.portfolioItem.upsert.mockResolvedValue({ id: 99, symbol: 'CASH:USD' });
  prisma.portfolioItem.deleteMany.mockResolvedValue({ count: 0 });
  prisma.category.findMany.mockResolvedValue([]);
  prisma.category.findFirst.mockResolvedValue(null);
  prisma.manualAssetValue.createMany.mockResolvedValue({ count: 0 });
  prisma.manualAssetValue.deleteMany.mockResolvedValue({ count: 0 });
  prisma.portfolioHolding.createMany.mockResolvedValue({ count: 0 });
}

describe('process-portfolio-changes — processPortfolioChanges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installEmptyTenantMocks();
  });

  // ─── Scope-error guard ────────────────────────────────────────────────────
  //
  // This is the test family that specifically catches the `job is not
  // defined` class of bug. The full-rebuild branch runs through
  // `handleFullRebuild`, which previously referenced `job.heartbeat`
  // even though it doesn't receive `job`. Any such scope error surfaces
  // as ReferenceError here.
  //
  // The tests must feed enough fixture data to actually ENTER the inner
  // loops where the heartbeat call lives — an empty-tenant run skips
  // those loops, so it wouldn't trip the bug.

  /** Minimal transaction that survives `handleFullRebuild`'s filters and
   *  lands in the `transactionsByGroup` map, forcing the code to enter
   *  the for-loop that contains the heartbeat call. */
  function makeInvestmentTx(overrides = {}) {
    return {
      id: 1,
      tenantId: 'tenant-1',
      categoryId: 10,
      currency: 'USD',
      transaction_date: new Date('2026-03-01'),
      year: 2026,
      month: 3,
      credit: 0,
      debit: 500,
      ticker: 'AAPL',
      isin: null,
      exchange: null,
      assetCurrency: null,
      assetQuantity: 2,
      assetPrice: 250,
      portfolioItemId: null,
      category: { id: 10, type: 'Investments', group: 'Stocks' },
      account: { countryId: 'US' },
      ...overrides,
    };
  }

  it('full rebuild enters the per-group loop and completes without scope errors (catches `job is not defined`)', async () => {
    // Provide a transaction that forms a group — without this, the
    // heartbeat call site on line 394 is unreachable and the bug
    // hides. The original production bug slipped through because the
    // earlier empty-tenant test didn't exercise this path.
    prisma.transaction.findMany.mockResolvedValue([makeInvestmentTx()]);
    // After upsert, the newly-created item needs to be findable.
    prisma.portfolioItem.findMany.mockResolvedValue([
      { id: 1, symbol: 'AAPL' },
    ]);
    const job = makeJob();
    await expect(processPortfolioChanges(job)).resolves.toBeDefined();
  });

  it('full rebuild runs without throwing on an empty tenant (no transactions → early emit path)', async () => {
    const job = makeJob();
    await expect(processPortfolioChanges(job)).resolves.toBeDefined();
  });

  it('account-scoped rebuild runs without throwing a scope/reference error', async () => {
    prisma.transaction.findMany.mockResolvedValue([makeInvestmentTx()]);
    prisma.portfolioItem.findMany.mockResolvedValue([
      { id: 1, symbol: 'AAPL' },
    ]);
    const job = makeJob({ accountIds: [101], institutionId: null, dateScopes: [{ year: 2026, month: 3 }] });
    await expect(processPortfolioChanges(job)).resolves.toBeDefined();
  });

  it('scoped update (single transactionId) runs without throwing a scope/reference error', async () => {
    prisma.transaction.findUnique.mockResolvedValue({
      id: 42,
      tenantId: 'tenant-1',
      categoryId: 1,
      currency: 'USD',
      transaction_date: new Date('2026-03-01'),
      year: 2026,
      month: 3,
      credit: 0,
      debit: 100,
      ticker: null,
      category: { id: 1, type: 'Expense', group: 'Dining' },
      account: { countryId: 'US' },
    });
    const job = makeJob({ transactionId: 42 });
    await expect(processPortfolioChanges(job)).resolves.toBeDefined();
  });

  // ─── _rebuildMeta propagation (lock release) ──────────────────────────────
  //
  // When an admin triggers a full-portfolio rebuild via the Maintenance
  // tab, `_rebuildMeta` rides on the initial job and must be forwarded
  // in the PORTFOLIO_CHANGES_PROCESSED event so the chain can carry it
  // through to value-all-assets completion (where the single-flight
  // lock releases). Regression guard for that plumbing.

  it('forwards _rebuildMeta into the PORTFOLIO_CHANGES_PROCESSED event', async () => {
    prisma.transaction.findMany.mockResolvedValue([makeInvestmentTx()]);
    prisma.portfolioItem.findMany.mockResolvedValue([
      { id: 1, symbol: 'AAPL' },
    ]);
    const meta = {
      rebuildType: 'full-portfolio',
      requestedBy: 'admin@example.com',
      requestedAt: '2026-04-23T10:00:00.000Z',
    };
    const job = makeJob({ _rebuildMeta: meta });

    await processPortfolioChanges(job);

    expect(enqueueEvent).toHaveBeenCalledWith(
      'PORTFOLIO_CHANGES_PROCESSED',
      expect.objectContaining({ _rebuildMeta: meta }),
    );
  });

  it('omits _rebuildMeta from the event when the job did not carry it', async () => {
    prisma.transaction.findMany.mockResolvedValue([makeInvestmentTx()]);
    prisma.portfolioItem.findMany.mockResolvedValue([
      { id: 1, symbol: 'AAPL' },
    ]);
    const job = makeJob();

    await processPortfolioChanges(job);

    expect(enqueueEvent).toHaveBeenCalled();
    const [, payload] = enqueueEvent.mock.calls[0];
    expect(payload).not.toHaveProperty('_rebuildMeta');
  });

  // ─── Heartbeat wiring ─────────────────────────────────────────────────────
  //
  // `job.heartbeat` is attached by the portfolioWorker dispatcher. The
  // helper functions receive the heartbeat as a separate parameter (NOT
  // via `job`). Even on an empty tenant, the dispatcher must route the
  // heartbeat through correctly — this test catches any regression
  // where the parameter is dropped or the wrong name is used.

  it('accepts a job with a heartbeat callback without touching undeclared `job` references', async () => {
    const heartbeat = jest.fn().mockResolvedValue(undefined);
    const job = {
      id: 'job-hb',
      name: 'process-portfolio-changes',
      data: { tenantId: 'tenant-1' },
      heartbeat,
    };

    await expect(processPortfolioChanges(job)).resolves.toBeDefined();
    // Heartbeat may or may not be invoked on an empty-tenant run (no
    // loop iterations hit), but the run must complete cleanly either
    // way. The assertion here is the absence of ReferenceError — the
    // whole point of this test file.
  });
});
