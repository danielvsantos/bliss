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
    findFirst: jest.fn(),
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
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  portfolioHolding: {
    createMany: jest.fn(),
  },
  incomeTerms: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  debtTerms: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  // Array form (batched ops) and interactive form (callback receives the client).
  $transaction: jest.fn((arg) =>
    typeof arg === 'function'
      ? arg(jest.requireMock('../../../../../prisma/prisma.js'))
      : Promise.all(arg)),
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
  prisma.portfolioItem.findFirst.mockResolvedValue(null);
  prisma.portfolioItem.create.mockResolvedValue({ id: 1 });
  prisma.portfolioItem.createMany.mockResolvedValue({ count: 0 });
  prisma.portfolioItem.update.mockResolvedValue({});
  prisma.portfolioItem.upsert.mockResolvedValue({ id: 99, symbol: 'CASH:USD' });
  prisma.portfolioItem.deleteMany.mockResolvedValue({ count: 0 });
  prisma.category.findMany.mockResolvedValue([]);
  prisma.category.findFirst.mockResolvedValue(null);
  prisma.manualAssetValue.createMany.mockResolvedValue({ count: 0 });
  prisma.manualAssetValue.deleteMany.mockResolvedValue({ count: 0 });
  prisma.manualAssetValue.findMany.mockResolvedValue([]);
  prisma.manualAssetValue.updateMany.mockResolvedValue({ count: 0 });
  prisma.portfolioHolding.createMany.mockResolvedValue({ count: 0 });
  prisma.incomeTerms.findMany.mockResolvedValue([]);
  prisma.incomeTerms.update.mockResolvedValue({});
  prisma.debtTerms.findMany.mockResolvedValue([]);
  prisma.debtTerms.update.mockResolvedValue({});
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

// ─── Passive Income (#77): income terms survive re-keying + newSecuritySymbols ──
describe('process-portfolio-changes — income terms & new security symbols', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installEmptyTenantMocks();
  });

  const bondTx = (overrides = {}) => ({
    id: 7,
    tenantId: 'tenant-1',
    categoryId: 20,
    accountId: 5,
    currency: 'BRL',
    transaction_date: new Date('2026-03-01'),
    year: 2026,
    month: 3,
    credit: 0,
    debit: 1000,
    ticker: 'Bonds - Tesouro IPCA 2035',
    portfolioItemId: null,
    category: { id: 20, type: 'Investments', group: 'Bonds', processingHint: 'MANUAL' },
    ...overrides,
  });

  it('moves income terms to the single new item with the same category and account (corrected description)', async () => {
    prisma.transaction.findMany.mockResolvedValue([bondTx()]);
    prisma.portfolioItem.findMany
      // Step 1: existing items in scope — the old, wrongly-described bond
      .mockResolvedValueOnce([{ id: 1, symbol: 'Bonds - Tesouro IPCA 2053', accountId: 5, categoryId: 20 }])
      // Step 5: all items after createMany
      .mockResolvedValueOnce([
        { id: 1, symbol: 'Bonds - Tesouro IPCA 2053', accountId: 5, categoryId: 20 },
        { id: 2, symbol: 'Bonds - Tesouro IPCA 2035', accountId: 5, categoryId: 20 },
      ]);
    prisma.incomeTerms.findMany.mockResolvedValue([{ id: 900, assetId: 1 }]);

    await processPortfolioChanges(makeJob());

    expect(prisma.incomeTerms.update).toHaveBeenCalledWith({ where: { id: 900 }, data: { assetId: 2 } });
    expect(prisma.portfolioItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1] } } });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('detaches income terms when no clear match exists, and still prunes', async () => {
    prisma.transaction.findMany.mockResolvedValue([bondTx({ categoryId: 21, category: { id: 21, type: 'Investments', group: 'Bonds' } })]);
    prisma.portfolioItem.findMany
      .mockResolvedValueOnce([{ id: 1, symbol: 'Old bond', accountId: 5, categoryId: 20 }])
      .mockResolvedValueOnce([
        { id: 1, symbol: 'Old bond', accountId: 5, categoryId: 20 },
        { id: 2, symbol: 'Bonds - Tesouro IPCA 2035', accountId: 5, categoryId: 21 },
      ]);
    prisma.incomeTerms.findMany.mockResolvedValue([{ id: 900, assetId: 1 }]);

    await processPortfolioChanges(makeJob());

    expect(prisma.incomeTerms.update).toHaveBeenCalledWith({
      where: { id: 900 },
      data: { assetId: null, orphanedAt: expect.any(Date), orphanedLabel: 'Old bond' },
    });
    expect(prisma.portfolioItem.deleteMany).toHaveBeenCalled();
  });

  it('detaches income terms when all transactions are gone (early-return prune)', async () => {
    prisma.portfolioItem.findMany.mockResolvedValueOnce([{ id: 3, symbol: 'Rental flat', accountId: 9, categoryId: 30 }]);
    prisma.incomeTerms.findMany.mockResolvedValue([{ id: 901, assetId: 3 }]);

    await processPortfolioChanges(makeJob());

    expect(prisma.incomeTerms.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 901 },
      data: expect.objectContaining({ assetId: null, orphanedLabel: 'Rental flat' }),
    }));
    expect(prisma.portfolioItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [3] } } });
    const [, payload] = enqueueEvent.mock.calls[0];
    expect(payload.newSecuritySymbols).toEqual([]);
  });

  it('emits newSecuritySymbols for newly created stock/ETF items on a full rebuild', async () => {
    prisma.transaction.findMany.mockResolvedValue([
      bondTx({ id: 1, ticker: 'VWCE', category: { id: 40, type: 'Investments', group: 'ETFs', processingHint: 'API_FUND' }, categoryId: 40 }),
      bondTx({ id: 2, ticker: 'Bonds - X', categoryId: 20 }),
    ]);
    prisma.portfolioItem.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 10, symbol: 'VWCE', accountId: 5, categoryId: 40 },
      { id: 11, symbol: 'Bonds - X', accountId: 5, categoryId: 20 },
    ]);

    await processPortfolioChanges(makeJob());

    const [, payload] = enqueueEvent.mock.calls[0];
    expect(payload.newSecuritySymbols).toEqual(['VWCE']);
    // processingHint is not a PortfolioItem column — must be stripped before createMany.
    const created = prisma.portfolioItem.createMany.mock.calls[0][0].data;
    expect(created.every((d) => !('processingHint' in d))).toBe(true);
  });

  it('emits newSecuritySymbols on a scoped update that creates a stock item', async () => {
    prisma.transaction.findUnique.mockResolvedValue({
      id: 42, tenantId: 'tenant-1', categoryId: 1, accountId: 5, currency: 'USD',
      transaction_date: new Date('2026-03-01'), year: 2026, month: 3,
      credit: 0, debit: 100, ticker: 'KO',
      category: { id: 1, type: 'Investments', group: 'Stocks', processingHint: 'API_STOCK' },
      account: { countryId: 'US' },
    });
    prisma.portfolioItem.create.mockResolvedValue({ id: 5, symbol: 'KO', source: 'SYNCED' });
    prisma.portfolioItem.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 5, transactions: [] });

    await processPortfolioChanges(makeJob({ transactionId: 42 }));

    expect(enqueueEvent).toHaveBeenCalledWith('PORTFOLIO_CHANGES_PROCESSED', expect.objectContaining({
      newSecuritySymbols: ['KO'],
    }));
  });

  // A ticker-less fund is keyed "<category>:<description>" (TICKER fallback) and
  // priced from manual values — its key must never reach the Twelve Data refresh.
  describe('ticker-less funds', () => {
    const { generateAssetKey } = require('../../../../workers/portfolio-handlers/asset-aggregator');
    const fundCategory = { id: 40, type: 'Investments', group: 'Funds', processingHint: 'API_FUND' };
    beforeEach(() => {
      generateAssetKey.mockImplementation((tx) => tx.ticker || `Funds:${tx.description}`);
    });
    afterEach(() => {
      generateAssetKey.mockImplementation((tx) => tx.ticker || null);
    });

    it('full rebuild: excludes a ticker-less fund from newSecuritySymbols', async () => {
      prisma.transaction.findMany.mockResolvedValue([
        bondTx({ id: 1, ticker: 'VWCE', category: fundCategory, categoryId: 40 }),
        bondTx({ id: 2, ticker: null, description: 'CDB PLUS FIRF', category: fundCategory, categoryId: 40 }),
      ]);
      prisma.portfolioItem.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 10, symbol: 'VWCE', accountId: 5, categoryId: 40 },
        { id: 11, symbol: 'Funds:CDB PLUS FIRF', accountId: 5, categoryId: 40 },
      ]);

      await processPortfolioChanges(makeJob());

      const created = prisma.portfolioItem.createMany.mock.calls[0][0].data;
      expect(created.find((d) => d.symbol === 'Funds:CDB PLUS FIRF')).toMatchObject({ source: 'MANUAL' });
      const [, payload] = enqueueEvent.mock.calls[0];
      expect(payload.newSecuritySymbols).toEqual(['VWCE']);
    });

    it('scoped update: a new ticker-less fund item emits no security symbol', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: 43, tenantId: 'tenant-1', categoryId: 40, accountId: 5, currency: 'BRL',
        transaction_date: new Date('2026-03-01'), year: 2026, month: 3,
        credit: 0, debit: 1000, ticker: null, description: 'CDB PLUS FIRF',
        category: fundCategory,
        account: { countryId: 'BR' },
      });
      prisma.portfolioItem.create.mockResolvedValue({ id: 6, symbol: 'Funds:CDB PLUS FIRF', source: 'MANUAL' });
      prisma.portfolioItem.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 6, transactions: [] });

      await processPortfolioChanges(makeJob({ transactionId: 43 }));

      expect(prisma.portfolioItem.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ symbol: 'Funds:CDB PLUS FIRF', source: 'MANUAL' }),
      }));
      expect(enqueueEvent).toHaveBeenCalledWith('PORTFOLIO_CHANGES_PROCESSED', expect.objectContaining({
        newSecuritySymbols: [],
      }));
    });
  });
});

// ─── Scoped update re-keys a transaction (#86 ghost items) ──────────────────
//
// Editing the description of a `category:description` asset (e.g. Real Estate)
// moves the transaction to a new item. The API relinks the transaction BEFORE
// emitting, so the job carries `previousPortfolioItemId`; these tests start
// from that real post-API state (transaction already on the new item).
describe('process-portfolio-changes — scoped update reconciles the previous item', () => {
  const { calculatePortfolioItemState } = require('../../../../utils/portfolioItemStateCalculator.js');

  const OLD = { id: 10, symbol: 'Real Estate:Flat', accountId: 5, categoryId: 7 };
  const NEW = { id: 11, symbol: 'Real Estate:Flat Lisbon', accountId: 5, categoryId: 7, source: 'MANUAL' };

  const makeEditedTx = (overrides = {}) => ({
    id: 42, tenantId: 'tenant-1', categoryId: 7, accountId: 5, currency: 'EUR',
    transaction_date: new Date('2026-03-01'), year: 2026, month: 3,
    credit: 0, debit: 200000, ticker: NEW.symbol,
    portfolioItemId: NEW.id, // already relinked by the API
    category: { id: 7, type: 'Investments', group: 'Real Estate' },
    account: { countryId: 'PT' },
    ...overrides,
  });
  const oldItem = (transactions = []) => ({ ...OLD, transactions, category: { type: 'Investments' } });
  const emittedIds = () =>
    enqueueEvent.mock.calls.find(([t]) => t === 'PORTFOLIO_CHANGES_PROCESSED')[1].portfolioItemIds;

  beforeEach(() => {
    jest.clearAllMocks();
    installEmptyTenantMocks();
    prisma.portfolioItem.findUnique
      .mockResolvedValueOnce(NEW)
      .mockResolvedValueOnce({ ...NEW, transactions: [] });
  });

  it('prunes the emptied old item and moves its terms and user manual values to the replacement', async () => {
    prisma.transaction.findUnique.mockResolvedValue(makeEditedTx());
    prisma.portfolioItem.findFirst.mockResolvedValue(oldItem());
    prisma.incomeTerms.findMany.mockImplementation(({ where }) =>
      Promise.resolve(where.assetId.in.includes(10) ? [{ id: 900, assetId: 10 }] : []));
    prisma.manualAssetValue.findMany.mockResolvedValue([{ assetId: 10 }]);

    await processPortfolioChanges(makeJob({ transactionId: 42, previousPortfolioItemId: 10 }));

    expect(prisma.portfolioItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 10, tenantId: 'tenant-1' },
    }));
    expect(prisma.incomeTerms.update).toHaveBeenCalledWith({ where: { id: 900 }, data: { assetId: 11 } });
    expect(prisma.manualAssetValue.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { assetId: 11 } }));
    expect(prisma.portfolioItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [10] } } });
    expect(emittedIds()).toContain(11);
    expect(emittedIds()).not.toContain(10);
  });

  it('recalculates (does not prune) the old item when it still has transactions', async () => {
    prisma.transaction.findUnique.mockResolvedValue(makeEditedTx());
    prisma.portfolioItem.findFirst.mockResolvedValue(oldItem([{ id: 43, debit: 1000 }]));

    await processPortfolioChanges(makeJob({ transactionId: 42, previousPortfolioItemId: 10 }));

    expect(prisma.portfolioItem.deleteMany).not.toHaveBeenCalled();
    expect(calculatePortfolioItemState).toHaveBeenCalledWith([{ id: 43, debit: 1000 }]);
    expect(prisma.portfolioItem.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 10 } }));
    expect(emittedIds()).toEqual(expect.arrayContaining([10, 11]));
  });

  it('re-seeds the old MANUAL item\'s auto-seeded prices from its remaining buys only (partial rename)', async () => {
    prisma.transaction.findUnique.mockResolvedValue(makeEditedTx());
    const remainingBuy = { id: 43, debit: 100000, currency: 'EUR', transaction_date: new Date('2025-01-01') };
    prisma.portfolioItem.findFirst.mockResolvedValue({ ...oldItem([remainingBuy]), source: 'MANUAL' });

    await processPortfolioChanges(makeJob({ transactionId: 42, previousPortfolioItemId: 10 }));

    expect(prisma.manualAssetValue.deleteMany).toHaveBeenCalledWith({
      where: { assetId: 10, notes: 'Auto-seeded from purchase transaction' },
    });
    const seeded = prisma.manualAssetValue.createMany.mock.calls
      .map(([arg]) => arg.data).flat().filter((r) => r.assetId === 10);
    expect(seeded).toHaveLength(1);
    expect(seeded[0].value.toString()).toBe('100000');
  });

  it('does nothing extra when the job carries no previous item and the transaction did not move', async () => {
    prisma.transaction.findUnique.mockResolvedValue(makeEditedTx());

    await processPortfolioChanges(makeJob({ transactionId: 42 }));

    expect(prisma.portfolioItem.findFirst).not.toHaveBeenCalled();
    expect(prisma.portfolioItem.deleteMany).not.toHaveBeenCalled();
  });

  it('zeroes (never deletes) the old item when the transaction is recategorised out of investments', async () => {
    // The API leaves the link untouched when the new category has no asset key.
    prisma.portfolioItem.findUnique.mockReset();
    prisma.transaction.findUnique.mockResolvedValue(makeEditedTx({
      ticker: null, portfolioItemId: 10, category: { id: 3, type: 'Expense', group: 'Housing' },
    }));
    prisma.portfolioItem.findFirst.mockResolvedValue(oldItem());

    await processPortfolioChanges(makeJob({ transactionId: 42, previousPortfolioItemId: 10 }));

    expect(prisma.transaction.update).toHaveBeenCalledWith({ where: { id: 42 }, data: { portfolioItemId: null } });
    expect(prisma.portfolioItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.manualAssetValue.updateMany).not.toHaveBeenCalled();
    expect(prisma.portfolioItem.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({ quantity: 0, currentValue: 0, costBasis: 0, currentValueInUSD: 0 }),
    });
    expect(emittedIds()).toContain(10);
  });

  it('zeroes (never deletes) the old item when the new item is in a different category', async () => {
    prisma.transaction.findUnique.mockResolvedValue(makeEditedTx());
    prisma.portfolioItem.findFirst.mockResolvedValue({ ...oldItem(), categoryId: 99 });

    await processPortfolioChanges(makeJob({ transactionId: 42, previousPortfolioItemId: 10 }));

    expect(prisma.portfolioItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.portfolioItem.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({ quantity: 0, currentValue: 0 }),
    });
  });

  it('ignores a previous item that belongs to another tenant (lookup is tenant-scoped)', async () => {
    prisma.transaction.findUnique.mockResolvedValue(makeEditedTx());
    prisma.portfolioItem.findFirst.mockResolvedValue(null);

    await processPortfolioChanges(makeJob({ transactionId: 42, previousPortfolioItemId: 10 }));

    expect(prisma.portfolioItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.portfolioItem.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 10 } }));
  });
});

// ─── Transaction DELETE (#94) ───────────────────────────────────────────────
//
// The row is already gone when the job runs; the event scheduler passes the
// deleted row's fields as `deletedTransaction`. Before #94 a delete only re-ran
// valuation: quantity/lots were never recomputed, emptied items were never
// pruned, and PORTFOLIO_CHANGES_PROCESSED was never emitted (no cash/analytics).
describe('process-portfolio-changes — transaction delete reconciles the item and cascades', () => {
  const { calculatePortfolioItemState } = require('../../../../utils/portfolioItemStateCalculator.js');

  const ITEM = { id: 10, symbol: 'VWCE', accountId: 5, categoryId: 7, source: 'SYNCED' };
  const CASH = { id: 20 };
  const deleted = (overrides = {}) => ({
    id: 42,
    portfolioItemId: ITEM.id,
    accountId: 5,
    transaction_date: '2026-08-04T00:00:00.000Z',
    currency: 'EUR',
    country: 'PT',
    categoryType: 'Investments',
    categoryGroup: 'ETFs',
    ...overrides,
  });
  const item = (transactions = [], overrides = {}) => ({ ...ITEM, transactions, category: { type: 'Investments' }, ...overrides });
  const emitted = () => enqueueEvent.mock.calls.find(([t]) => t === 'PORTFOLIO_CHANGES_PROCESSED')?.[1];

  beforeEach(() => {
    jest.clearAllMocks();
    installEmptyTenantMocks();
    // First findFirst = the deleted row's item, second = its cash item.
    prisma.portfolioItem.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(where.category?.processingHint === 'CASH' ? CASH : null));
  });

  it('prunes an item whose only buy was deleted, detaching its income terms, and does not read the deleted row', async () => {
    prisma.portfolioItem.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(where.category?.processingHint === 'CASH' ? CASH : item()));
    prisma.incomeTerms.findMany.mockResolvedValue([{ id: 900, assetId: 10 }]);

    await processPortfolioChanges(makeJob({ deletedTransaction: deleted() }));

    expect(prisma.transaction.findUnique).not.toHaveBeenCalled();
    expect(prisma.portfolioItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 10, tenantId: 'tenant-1' },
    }));
    expect(prisma.incomeTerms.update).toHaveBeenCalledWith({
      where: { id: 900 },
      data: expect.objectContaining({ assetId: null, orphanedLabel: 'VWCE' }),
    });
    expect(prisma.portfolioItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [10] } } });
    expect(prisma.portfolioItem.update).not.toHaveBeenCalled();
    expect(emitted().portfolioItemIds).toEqual([20]);
  });

  it('recalculates quantity/lots from the remaining buys and re-seeds MANUAL prices when one of several buys is deleted', async () => {
    const remainingBuy = { id: 43, debit: 100, currency: 'EUR', transaction_date: new Date('2026-07-01') };
    prisma.portfolioItem.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(where.category?.processingHint === 'CASH' ? CASH : item([remainingBuy], { source: 'MANUAL' })));

    await processPortfolioChanges(makeJob({ deletedTransaction: deleted() }));

    expect(prisma.portfolioItem.deleteMany).not.toHaveBeenCalled();
    expect(calculatePortfolioItemState).toHaveBeenCalledWith([remainingBuy]);
    expect(prisma.portfolioItem.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 10 } }));
    expect(prisma.manualAssetValue.deleteMany).toHaveBeenCalledWith({
      where: { assetId: 10, notes: 'Auto-seeded from purchase transaction' },
    });
    const seeded = prisma.manualAssetValue.createMany.mock.calls.map(([arg]) => arg.data).flat();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].value.toString()).toBe('100');
    expect(emitted().portfolioItemIds).toEqual([10, 20]);
  });

  it('emits PORTFOLIO_CHANGES_PROCESSED with the deleted row\'s date scope so cash and analytics cascade', async () => {
    await processPortfolioChanges(makeJob({ deletedTransaction: deleted(), _rebuildMeta: { rebuildType: 'x' } }));

    expect(emitted()).toEqual({
      tenantId: 'tenant-1',
      portfolioItemIds: [20],
      newSecuritySymbols: [],
      dateScopes: [{ year: 2026, month: 8, currency: 'EUR', type: 'Investments', group: 'ETFs', country: 'PT' }],
      _rebuildMeta: { rebuildType: 'x' },
    });
    // The cash item is looked up, never created by a delete.
    expect(prisma.portfolioItem.upsert).not.toHaveBeenCalled();
  });

  it('still emits the cascade when the deleted row had no portfolio item', async () => {
    await processPortfolioChanges(makeJob({ deletedTransaction: deleted({ portfolioItemId: null }) }));

    expect(prisma.portfolioItem.deleteMany).not.toHaveBeenCalled();
    expect(emitted().dateScopes).toHaveLength(1);
  });
});
