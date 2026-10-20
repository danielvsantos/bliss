/**
 * Integration: eToro copy trading sync + valuation against the real bliss_test
 * database (#143).
 *
 * - Two tenants copying the same investor: each tenant's data is fetched with
 *   its own (decrypted) key and lands in its own rows.
 * - A sync writes copies, mapped holdings and today's value, creates no
 *   transaction, and revalues the linked Copy Trading holding.
 * - Valuation: from the first eToro day the holding is worth eToro's copy
 *   value; days before keep the pre-connection behaviour (cost basis).
 * - A revoked key → NEEDS_RECONNECT, last value kept, the job resolves.
 * - A copy missing from eToro's response → CLOSED, value carried forward.
 *
 * The eToro client and the queues are mocked; Postgres is real.
 * Requires: bliss_test with migrations applied.
 */

const mockPortfolioAdd = jest.fn().mockResolvedValue({});
jest.mock('../../queues/portfolioQueue', () => ({
  getPortfolioQueue: () => ({ add: mockPortfolioAdd }),
}));
const mockSyncAdd = jest.fn().mockResolvedValue({});
jest.mock('../../queues/plaidSyncQueue', () => ({
  getPlaidSyncQueue: () => ({ add: mockSyncAdd }),
  etoroSyncOpts: (id) => ({ deduplication: { id: `etoro-sync:${id}` } }),
}));
jest.mock('../../utils/redis', () => ({ getRedisConnection: jest.fn(() => ({})) }));

const { UnrecoverableError } = require('bullmq');
const prisma = require('../../../prisma/prisma');
const { createIsolatedTenant, teardownTenant } = require('../helpers/tenant');
const { ensureReferenceData } = require('../helpers/referenceData');
const { EtoroError } = require('@bliss/shared/etoro');
const { syncConnection, syncAll, __setEtoroClientFactoryForTests } = require('../../workers/handlers/etoroSync');
const generatePortfolioValuation = require('../../workers/portfolio-handlers/valuation');

const INVESTOR = 'TopInvestor';
const INSTRUMENTS = new Map([
  [1001, { instrumentID: 1001, symbolFull: 'AMZN', exchangeID: 4, instrumentTypeID: 5 }],
  [1002, { instrumentID: 1002, symbolFull: 'AMZN.RTH', exchangeID: 33, instrumentTypeID: 5 }],
  [1003, { instrumentID: 1003, symbolFull: 'AIR.PA', exchangeID: 9, instrumentTypeID: 5 }],
  [1004, { instrumentID: 1004, symbolFull: 'BTC', exchangeID: 8, instrumentTypeID: 10 }],
]);

/** eToro responses for one account holding one copy of INVESTOR worth `value`. */
const responses = (value, { mirrorId = 77, mirrors = true } = {}) => ({
  aggregate: {
    accountCurrency: 'USD',
    mirrors: [
      { mirrorId: 0, mirrorTotals: { mirrorLiquidationValue: 5 }, instrumentAggregates: [] },
      ...(mirrors ? [{
        mirrorId,
        mirrorTotals: { mirrorLiquidationValue: value },
        mirrorAvailableCash: value * 0.1,
        instrumentAggregates: [
          { instrumentId: 1001, liquidationValueAccountCurrency: value * 0.4 },
          { instrumentId: 1002, liquidationValueAccountCurrency: value * 0.1 },
          { instrumentId: 1003, liquidationValueAccountCurrency: value * 0.3 },
          { instrumentId: 1004, liquidationValueAccountCurrency: value * 0.1 },
        ],
      }] : []),
    ],
  },
  portfolio: {
    clientPortfolio: {
      mirrors: mirrors ? [{ mirrorID: mirrorId, parentUsername: INVESTOR, parentCID: 555, startedCopyDate: '2026-01-05T10:00:00Z' }] : [],
    },
  },
});

const clientsByKey = new Map(); // apiKey → fake client
const keysSeen = [];
const fakeClient = (r) => ({
  getMe: jest.fn(async () => ({ cid: 'x', username: 'u', scopes: ['trade.real:read'] })),
  getAggregatePortfolio: jest.fn(async () => r.aggregate),
  getPortfolio: jest.fn(async () => r.portfolio),
  getInstruments: jest.fn(async (ids) => new Map(ids.map((id) => [id, INSTRUMENTS.get(id)]).filter(([, m]) => m))),
});

async function setupTenant(suffix, apiKey, ref) {
  const { tenantId } = await createIsolatedTenant({ suffix });
  const user = await prisma.user.create({ data: { email: `etoro-${suffix}-${Date.now()}@test.local`, tenantId, role: 'admin' } });
  const account = await prisma.account.create({
    data: { name: 'eToro', accountNumber: 'ETORO-1', bankId: ref.bankId, countryId: ref.countryId, currencyCode: 'USD', tenantId },
  });
  const category = await prisma.category.create({
    data: {
      name: 'Copy Trading', group: 'Funds', type: 'Investments', tenantId,
      processingHint: 'COPY_TRADING', portfolioItemKeyStrategy: 'TICKER', defaultCategoryCode: 'COPY_TRADING',
    },
  });
  const item = await prisma.portfolioItem.create({
    data: { tenantId, categoryId: category.id, accountId: account.id, symbol: INVESTOR.toLowerCase(), currency: 'USD', source: 'SYNCED' },
  });
  // The user's own record of the copy: invested 1,000 USD on Jan 10.
  await prisma.transaction.create({
    data: {
      transaction_date: new Date('2026-01-10T00:00:00Z'), year: 2026, quarter: 'Q1', month: 1, day: 10,
      categoryId: category.id, description: `Copy ${INVESTOR}`, debit: 1000, currency: 'USD',
      accountId: account.id, assetQuantity: 1, assetPrice: 1000, ticker: INVESTOR.toLowerCase(),
      tenantId, portfolioItemId: item.id,
    },
  });
  const connection = await prisma.etoroConnection.create({
    data: {
      tenantId, createdByUserId: user.id, accountId: account.id, etoroCid: `cid-${suffix}`,
      etoroUsername: `me-${suffix}`, apiKey, userKey: `${apiKey}-user`, keyLast4: apiKey.slice(-4),
      scopes: ['trade.real:read'], connectedAt: new Date(Date.now() - 60_000),
    },
  });
  return { tenantId, account, category, item, connection };
}

const job = (t) => ({ id: `j-${t.connection.id}`, name: 'ETORO_SYNC', data: { connectionId: t.connection.id, tenantId: t.tenantId } });
const today = () => new Date(new Date().toISOString().slice(0, 10));

let a;
let b;

beforeAll(async () => {
  const ref = await ensureReferenceData({ countryId: 'USA', currencyCode: 'USD' });
  a = await setupTenant('etoro-a', 'key-tenant-a', ref);
  b = await setupTenant('etoro-b', 'key-tenant-b', ref);
  clientsByKey.set('key-tenant-a', fakeClient(responses(1234.5)));
  clientsByKey.set('key-tenant-b', fakeClient(responses(800)));
  __setEtoroClientFactoryForTests(({ apiKey, userKey }) => {
    keysSeen.push([apiKey, userKey]);
    return clientsByKey.get(apiKey);
  });
});

afterAll(async () => {
  __setEtoroClientFactoryForTests(null);
  await teardownTenant(a.tenantId);
  await teardownTenant(b.tenantId);
  await prisma.$disconnect();
});

beforeEach(() => {
  mockPortfolioAdd.mockClear();
  keysSeen.length = 0;
});

describe('syncConnection', () => {
  it('stores each tenant\'s copy with its own key, creates no transaction, revalues the linked holding', async () => {
    const txBefore = await prisma.transaction.count({ where: { tenantId: a.tenantId } });

    await expect(syncConnection(job(a))).resolves.toMatchObject({ status: 'SUCCESS', copies: 1, linked: 1 });
    await expect(syncConnection(job(b))).resolves.toMatchObject({ status: 'SUCCESS', copies: 1, linked: 1 });

    // Each tenant's keys, decrypted, and only those.
    expect(keysSeen).toEqual([['key-tenant-a', 'key-tenant-a-user'], ['key-tenant-b', 'key-tenant-b-user']]);

    const copyA = await prisma.etoroCopy.findFirst({ where: { tenantId: a.tenantId } });
    expect(copyA).toMatchObject({ mirrorId: '77', parentUsername: 'topinvestor', parentCid: '555', status: 'ACTIVE' });
    expect(Number(copyA.lastValue)).toBe(1234.5);
    expect(Number(copyA.cashPct)).toBeCloseTo(10);
    // AMZN.RTH is stored as its own holding, mapped as a US variant; the merge happens on read.
    expect(copyA.holdings.map((h) => [h.etoroSymbol, h.symbol, h.exchange, h.nonEquity ?? null, h.valuePct])).toEqual([
      ['AMZN', 'AMZN', 'XNAS', null, 40],
      ['AIR.PA', 'AIR', 'XPAR', null, 30],
      ['AMZN.RTH', 'AMZN', null, null, 10],
      ['BTC', 'BTC', null, 'CRYPTO', 10],
    ]);

    const valuesA = await prisma.etoroCopyValue.findMany({ where: { tenantId: a.tenantId } });
    const valuesB = await prisma.etoroCopyValue.findMany({ where: { tenantId: b.tenantId } });
    expect(valuesA.map((v) => Number(v.value))).toEqual([1234.5]);
    expect(valuesB.map((v) => Number(v.value))).toEqual([800]);

    expect(await prisma.transaction.count({ where: { tenantId: a.tenantId } })).toBe(txBefore);
    expect(mockPortfolioAdd).toHaveBeenCalledWith('value-portfolio-items', expect.objectContaining({
      tenantId: a.tenantId, portfolioItemIds: [a.item.id],
    }));
    const conn = await prisma.etoroConnection.findUnique({ where: { id: a.connection.id } });
    expect(conn).toMatchObject({ lastSyncStatus: 'SUCCESS', status: 'ACTIVE' });
  });

  it('a second sync the same day updates today\'s value instead of adding a row', async () => {
    clientsByKey.set('key-tenant-a', fakeClient(responses(1300)));
    await syncConnection(job(a));
    const values = await prisma.etoroCopyValue.findMany({ where: { tenantId: a.tenantId } });
    expect(values.map((v) => Number(v.value))).toEqual([1300]);
  });
});

describe('valuation of a linked Copy Trading holding', () => {
  it('uses eToro\'s copy value from the first eToro day and cost basis before it', async () => {
    const item = await prisma.portfolioItem.findUnique({ where: { id: a.item.id }, include: { category: true } });
    await generatePortfolioValuation({ data: { tenantId: a.tenantId, assets: [item] } });

    const history = await prisma.portfolioValueHistory.findMany({ where: { assetId: a.item.id }, orderBy: { date: 'asc' } });
    const last = history[history.length - 1];
    expect(last.date.toISOString().slice(0, 10)).toBe(today().toISOString().slice(0, 10));
    expect(Number(last.nativeValue)).toBe(1300);
    expect(Number(last.valueInUSD)).toBe(1300);
    expect(last.source).toBe('ETORO');

    // Before the connection: unchanged pre-connection behaviour.
    const before = history.filter((h) => h.date < today());
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((h) => h.source === 'COST_BASIS_FALLBACK' && Number(h.nativeValue) === 1000)).toBe(true);

    const updated = await prisma.portfolioItem.findUnique({ where: { id: a.item.id } });
    expect(Number(updated.currentValue)).toBe(1300);
  });

  it('a manual value on the same day still wins (R11)', async () => {
    await prisma.manualAssetValue.create({
      data: { assetId: a.item.id, tenantId: a.tenantId, date: today(), value: 1500, currency: 'USD' },
    });
    const item = await prisma.portfolioItem.findUnique({ where: { id: a.item.id }, include: { category: true } });
    await generatePortfolioValuation({ data: { tenantId: a.tenantId, assets: [item] } });
    const last = await prisma.portfolioValueHistory.findFirst({ where: { assetId: a.item.id }, orderBy: { date: 'desc' } });
    expect(Number(last.nativeValue)).toBe(1500);
    expect(last.source).toBe('Manual');
    await prisma.manualAssetValue.deleteMany({ where: { assetId: a.item.id } });
  });
});

describe('failures', () => {
  it('a revoked key → NEEDS_RECONNECT, last value kept, job resolves; the other tenant is unaffected', async () => {
    const revoked = fakeClient(responses(1));
    revoked.getAggregatePortfolio.mockRejectedValue(new EtoroError('KEY_INVALID', 'refused', { status: 401 }));
    revoked.getMe.mockRejectedValue(new EtoroError('KEY_INVALID', 'refused', { status: 401 }));
    clientsByKey.set('key-tenant-b', revoked);

    await expect(syncConnection(job(b))).resolves.toEqual({ status: 'NEEDS_RECONNECT' });
    const conn = await prisma.etoroConnection.findUnique({ where: { id: b.connection.id } });
    expect(conn).toMatchObject({ status: 'NEEDS_RECONNECT', errorCode: 'KEY_INVALID', lastSyncStatus: 'FAILED' });
    const values = await prisma.etoroCopyValue.findMany({ where: { tenantId: b.tenantId } });
    expect(values.map((v) => Number(v.value))).toEqual([800]);

    // Not ACTIVE any more: later runs skip it.
    await expect(syncConnection(job(b))).resolves.toEqual({ skipped: 'inactive' });
    await expect(syncConnection(job(a))).resolves.toMatchObject({ status: 'SUCCESS' });
  });

  it('a refusal the /me probe does not confirm is retryable and leaves the connection ACTIVE', async () => {
    const flaky = fakeClient(responses(1));
    flaky.getAggregatePortfolio.mockRejectedValue(new EtoroError('KEY_INVALID', 'refused', { status: 403 }));
    clientsByKey.set('key-tenant-a', flaky);
    await expect(syncConnection(job(a))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const conn = await prisma.etoroConnection.findUnique({ where: { id: a.connection.id } });
    expect(conn).toMatchObject({ status: 'ACTIVE', lastSyncStatus: 'FAILED' });
  });

  it('a changed response shape fails without retries and writes nothing', async () => {
    const broken = fakeClient(responses(1));
    broken.getAggregatePortfolio.mockResolvedValue({ unexpected: true });
    clientsByKey.set('key-tenant-a', broken);
    const before = await prisma.etoroCopy.findFirst({ where: { tenantId: a.tenantId } });
    await expect(syncConnection(job(a))).rejects.toBeInstanceOf(UnrecoverableError);
    const after = await prisma.etoroCopy.findFirst({ where: { tenantId: a.tenantId } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('a copy stopped on eToro is CLOSED and keeps its last value', async () => {
    clientsByKey.set('key-tenant-a', fakeClient(responses(0, { mirrors: false })));
    await syncConnection(job(a));
    const copy = await prisma.etoroCopy.findFirst({ where: { tenantId: a.tenantId } });
    expect(copy).toMatchObject({ status: 'CLOSED', closedAt: expect.any(Date) });
    expect(Number(copy.lastValue)).toBe(1300);
    // Still linked: the holding is revalued and keeps the last eToro value.
    expect(mockPortfolioAdd).toHaveBeenCalledWith('value-portfolio-items', expect.objectContaining({ portfolioItemIds: [a.item.id] }));
  });
});

describe('syncAll', () => {
  it('fans out one deduplicated sync per ACTIVE connection only', async () => {
    mockSyncAdd.mockClear();
    await syncAll();
    const queued = mockSyncAdd.mock.calls.map(([, data]) => data.connectionId);
    expect(queued).toContain(a.connection.id);
    expect(queued).not.toContain(b.connection.id); // NEEDS_RECONNECT
    const call = mockSyncAdd.mock.calls.find(([, data]) => data.connectionId === a.connection.id);
    expect(call).toEqual(['ETORO_SYNC', expect.objectContaining({ tenantId: a.tenantId, _trigger: 'nightly' }), { deduplication: { id: `etoro-sync:${a.connection.id}` } }]);
  });
});
