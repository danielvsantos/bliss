/**
 * Integration: the eToro look-through watchlist (#143, R20) against the real
 * bliss_test database.
 *
 * Symbols held only inside ACTIVE eToro copies (any tenant, connection not
 * removed) that have no SecurityMaster data or stale fundamentals. Symbols
 * held directly are left to the nightly refresh; crypto / commodities and
 * unresolved instruments are never looked up. Only symbols come back.
 */

const prisma = require('../../../prisma/prisma');
const { createIsolatedTenant, teardownTenant } = require('../helpers/tenant');
const { ensureReferenceData } = require('../helpers/referenceData');
const { getLookThroughWatchlistSymbols, getCopyHoldingSymbols } = require('../../services/securityMasterService');

const P = `ZW${Date.now().toString(36).toUpperCase()}`;
const S = (n) => `${P}${n}`;
let a;
let b;

async function connection(tenantId, status = 'ACTIVE') {
  const user = await prisma.user.create({ data: { email: `wl-${status}-${Date.now()}-${Math.random()}@test.local`, tenantId } });
  return prisma.etoroConnection.create({
    data: {
      tenantId, createdByUserId: user.id, etoroCid: `cid-${Math.random()}`, etoroUsername: 'u',
      apiKey: 'k', userKey: 'u', keyLast4: 'k', scopes: ['x:read'], status,
    },
  });
}

const holding = (symbol, extra = {}) => ({ instrumentId: 1, etoroSymbol: symbol, symbol, exchange: 'XNAS', valuePct: 10, ...extra });

beforeAll(async () => {
  const ref = await ensureReferenceData({ countryId: 'USA', currencyCode: 'USD' });
  a = (await createIsolatedTenant({ suffix: 'wl-a' })).tenantId;
  b = (await createIsolatedTenant({ suffix: 'wl-b' })).tenantId;

  const active = await connection(a);
  await prisma.etoroCopy.create({
    data: {
      tenantId: a, connectionId: active.id, mirrorId: '1', parentUsername: 'x', status: 'ACTIVE',
      holdings: [
        holding(S(1)),
        holding(S(1), { exchange: null, usVariant: true }), // RTH line of the same company
        holding(S(2)), // held directly by tenant B
        holding(S(3)), // fresh SecurityMaster data
        holding(S(6), { exchange: 'XPAR' }), // stale SecurityMaster data
        holding('BTC', { exchange: null, nonEquity: 'CRYPTO' }),
        { instrumentId: 9, etoroSymbol: 'X.ZZ', unresolved: true, reason: 'UNKNOWN_EXCHANGE', valuePct: 1 },
      ],
    },
  });
  await prisma.etoroCopy.create({
    data: { tenantId: a, connectionId: active.id, mirrorId: '2', parentUsername: 'y', status: 'CLOSED', holdings: [holding(S(4))] },
  });
  const removed = await connection(b, 'REMOVED');
  await prisma.etoroCopy.create({
    data: { tenantId: b, connectionId: removed.id, mirrorId: '3', parentUsername: 'z', status: 'ACTIVE', holdings: [holding(S(5))] },
  });

  // Tenant B holds S2 directly.
  const stocks = await prisma.category.create({
    data: { name: 'Stocks', group: 'Stocks', type: 'Investments', tenantId: b, processingHint: 'API_STOCK', portfolioItemKeyStrategy: 'TICKER' },
  });
  const account = await prisma.account.create({
    data: { name: 'Broker', accountNumber: 'B-1', bankId: ref.bankId, countryId: ref.countryId, currencyCode: 'USD', tenantId: b },
  });
  await prisma.portfolioItem.create({
    data: { tenantId: b, categoryId: stocks.id, accountId: account.id, symbol: S(2), currency: 'USD', source: 'SYNCED', quantity: 5 },
  });

  await prisma.securityMaster.createMany({
    data: [
      { symbol: S(3), lastFundamentalsUpdate: new Date() },
      { symbol: S(6), lastFundamentalsUpdate: new Date(Date.now() - 10 * 86400_000) },
    ],
  });
});

afterAll(async () => {
  await prisma.securityMaster.deleteMany({ where: { symbol: { startsWith: P } } });
  await teardownTenant(a);
  await teardownTenant(b);
  await prisma.$disconnect();
});

const ours = (list) => list.filter((s) => s.symbol.startsWith(P));

it('lists the stock/ETF symbols of active copies on live connections, once each, preferring a venue', async () => {
  const symbols = ours(await getCopyHoldingSymbols());
  expect(symbols).toEqual([
    { symbol: S(1), exchange: 'XNAS' },
    { symbol: S(2), exchange: 'XNAS' },
    { symbol: S(3), exchange: 'XNAS' },
    { symbol: S(6), exchange: 'XPAR' },
  ]);
});

it('watches only symbols held nowhere directly, with missing or stale data', async () => {
  // US venues go without a MIC: Twelve Data files AMZN under XNGS, and
  // mic_code=XNAS returns nothing. Other venues keep theirs.
  expect(ours(await getLookThroughWatchlistSymbols())).toEqual([
    { symbol: S(1), exchange: null },
    { symbol: S(6), exchange: 'XPAR' },
  ]);
  // A longer staleness window keeps the 10-day-old row out.
  expect(ours(await getLookThroughWatchlistSymbols({ staleDays: 30 }))).toEqual([{ symbol: S(1), exchange: null }]);
});
