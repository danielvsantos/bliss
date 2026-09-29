/**
 * Unit tests for GET /api/portfolio/assets (Manage Assets #81).
 *
 * Mocked-handler pattern: withAuth, rate limiter, cors, Sentry, currency
 * conversion and Prisma are mocked. The real classifiers from
 * @bliss/shared/portfolio run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => async (req: any, res: any) => {
    req.user = { id: 1, tenantId: 'tenant-a', role: 'admin', email: 'a@test.com' };
    return handler(req, res);
  },
}));

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));

const { mockSentry } = vi.hoisted(() => ({ mockSentry: { captureException: vi.fn() } }));
vi.mock('@sentry/nextjs', () => mockSentry);

// USD → EUR at 0.5; everything else unknown (resolver falls back to 1).
vi.mock('../../../utils/currencyConversion.js', () => ({
  convertCurrency: vi.fn(async (amount: number, from: string, to: string) =>
    from === 'USD' && to === 'EUR' ? amount * 0.5 : null),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenant: { findUnique: vi.fn() },
    portfolioItem: { findMany: vi.fn() },
    incomeTerms: { count: vi.fn() },
    securityMaster: { findMany: vi.fn() },
    manualAssetValue: { groupBy: vi.fn() },
  },
}));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/portfolio/assets.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function makeReq(query: Record<string, string> = {}, method = 'GET'): NextApiRequest {
  return { method, headers: {}, cookies: {}, body: {}, query } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

async function call(query: Record<string, string> = {}, method = 'GET') {
  const res = makeRes();
  await handler(makeReq(query, method), res as unknown as NextApiResponse);
  return res;
}

const cat = (over: Record<string, unknown>) => ({
  name: 'Stocks', type: 'Investments', group: 'Stocks', processingHint: 'API_STOCK', defaultCategoryCode: 'STOCKS', ...over,
});

function item(over: Record<string, unknown>) {
  return {
    id: 1,
    symbol: 'X',
    accountId: 10,
    currency: 'USD',
    quantity: '10',
    currentValue: '100',
    currentValueInUSD: '100',
    hasLotMismatch: false,
    assetClassOverride: null,
    category: cat({}),
    account: { name: 'Broker' },
    incomeTerms: null,
    debtTerms: null,
    ...over,
  };
}

const ITEMS = [
  item({ id: 1, symbol: 'AAPL' }),
  item({ id: 2, symbol: 'VWCE', category: cat({ name: 'ETFs', group: 'ETFs', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS' }) }),
  item({
    id: 3, symbol: 'Flat Lisbon', accountId: 11, account: { name: 'Home' },
    category: cat({ name: 'Real Estate', type: 'Asset', group: 'Real Estate', processingHint: 'MANUAL', defaultCategoryCode: 'REAL_ESTATE' }),
    quantity: '1', currentValue: '300000', currentValueInUSD: '320000',
    incomeTerms: { id: 9, incomeType: 'RENT', issuerType: null, dividendPerUnit: null, isDistributing: true, yieldPct: null },
  }),
  item({
    id: 4, symbol: 'Mortgage', accountId: null, account: null, quantity: '0', currentValue: '-200000', currentValueInUSD: '-210000',
    category: cat({ name: 'Mortgage', type: 'Debt', group: 'Real Estate Loan', processingHint: 'AMORTIZING_LOAN', defaultCategoryCode: 'MORTGAGE' }),
    debtTerms: { id: 5 },
  }),
  item({ id: 5, symbol: 'KO', hasLotMismatch: true, incomeTerms: { id: 7, incomeType: 'DIVIDEND', issuerType: null, dividendPerUnit: '1.94', isDistributing: true, yieldPct: null } }),
  item({ id: 6, symbol: 'Art', category: cat({ name: 'Collectibles', type: 'Asset', group: 'Collectible', processingHint: 'MANUAL', defaultCategoryCode: 'COLLECTIBLE' }), quantity: '1' }),
  item({ id: 7, symbol: 'AAPL', accountId: 11, account: { name: 'Home' }, assetClassOverride: 'FUND' }),
];

const SECURITIES = [
  { symbol: 'AAPL', name: 'Apple Inc', assetType: 'Common Stock', etfComposition: null, dividendTrusted: true, recentDividends: [{ exDate: '2026-08-11', amount: 0.26 }] },
  { symbol: 'VWCE', name: 'Vanguard FTSE All-World', assetType: 'ETF', etfComposition: null, dividendTrusted: false, recentDividends: null },
  { symbol: 'KO', name: 'Coca-Cola Co', assetType: 'Common Stock', etfComposition: null, dividendTrusted: true, recentDividends: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockPrisma.tenant.findUnique.mockResolvedValue({ portfolioCurrency: 'EUR' });
  mockPrisma.portfolioItem.findMany.mockImplementation(async (args: any) => {
    // Facet query selects only category.group + account.
    if (!args.select.id) {
      return ITEMS.map((i) => ({ category: { group: i.category.group }, account: i.account ? { id: i.accountId, name: i.account.name } : null }));
    }
    return ITEMS;
  });
  mockPrisma.incomeTerms.count.mockResolvedValue(2);
  mockPrisma.securityMaster.findMany.mockResolvedValue(SECURITIES);
  mockPrisma.manualAssetValue.groupBy.mockImplementation(async (args: any) =>
    [
      { assetId: 3, _max: { date: daysAgo(45) } },
      { assetId: 6, _max: { date: daysAgo(5) } },
    ].filter((r) => args.where.assetId.in.includes(r.assetId)));
});

afterEach(() => {
  vi.useRealTimers();
});

const itemsCall = () => mockPrisma.portfolioItem.findMany.mock.calls.find((c: any[]) => c[0].select.id)![0];

describe('GET /api/portfolio/assets', () => {
  it('sorts by urgency by default: stale price, missing terms, lot mismatch, then A–Z', async () => {
    const res = await call();
    // 3 stale (45d) · 2 VWCE income missing · 5 KO lot mismatch · rest by group/symbol.
    expect(res._body.items.map((r: any) => r.id)).toEqual([3, 2, 5, 6, 4, 1, 7]);
    expect(res._body.items.map((r: any) => r.needsAttention)).toEqual([true, true, true, false, false, false, false]);
    expect(res._body.totals).toEqual({ count: 7, attention: 3 });
    expect(res._body.items[0]).not.toHaveProperty('urgency');
  });

  it('ranks price urgency critical (no value / 90d+) > warning (60d+) > stale (30d+)', async () => {
    const manual = cat({ name: 'Real Estate', type: 'Asset', group: 'Real Estate', processingHint: 'MANUAL', defaultCategoryCode: 'REAL_ESTATE' });
    mockPrisma.portfolioItem.findMany.mockImplementation(async (args: any) =>
      args.select.id
        ? [
            item({ id: 11, symbol: 'A-stale', category: manual, quantity: '1' }),
            item({ id: 12, symbol: 'B-warning', category: manual, quantity: '1' }),
            item({ id: 13, symbol: 'C-critical', category: manual, quantity: '1' }),
            item({ id: 14, symbol: 'D-none', category: manual, quantity: '1' }),
          ]
        : []);
    mockPrisma.manualAssetValue.groupBy.mockResolvedValue([
      { assetId: 11, _max: { date: daysAgo(40) } },
      { assetId: 12, _max: { date: daysAgo(70) } },
      { assetId: 13, _max: { date: daysAgo(120) } },
    ]);
    const res = await call();
    expect(res._body.items.map((r: any) => r.id)).toEqual([13, 14, 12, 11]);
  });

  it('flags amortizing loans without debt terms (not credit cards, not loans with terms)', async () => {
    const mortgage = cat({ name: 'Mortgage', type: 'Debt', group: 'Real Estate Loan', processingHint: 'AMORTIZING_LOAN', defaultCategoryCode: 'MORTGAGE' });
    const card = cat({ name: 'Credit Card Debt', type: 'Debt', group: 'Personal Debt', processingHint: 'SIMPLE_LIABILITY', defaultCategoryCode: 'CREDIT_CARD_DEBT' });
    mockPrisma.portfolioItem.findMany.mockImplementation(async (args: any) =>
      args.select.id
        ? [
            item({ id: 21, symbol: 'Loan A', category: mortgage, quantity: '0', debtTerms: null }),
            item({ id: 22, symbol: 'Loan B', category: mortgage, quantity: '0', debtTerms: { id: 1 } }),
            item({ id: 23, symbol: 'Visa', category: card, quantity: '0', debtTerms: null }),
          ]
        : []);
    const res = await call();
    const byId = (id: number) => res._body.items.find((r: any) => r.id === id);
    expect(byId(21)).toMatchObject({ debtTermsMissing: true, needsAttention: true });
    expect(byId(22)).toMatchObject({ debtTermsMissing: false, needsAttention: false });
    expect(byId(23)).toMatchObject({ debtTermsMissing: false, needsAttention: false });
    expect(res._body.items[0].id).toBe(21);
    expect(res._body.statusCounts.debtTermsMissing).toBe(1);
    expect((await call({ status: 'debtTermsMissing' }))._body.items.map((r: any) => r.id)).toEqual([21]);
  });

  it('returns counts per status over the current filters, ignoring the status filter', async () => {
    const expected = { stale: 1, debtTermsMissing: 0, incomeMissing: 1, lotMismatch: 1, dividendOverride: 1, assetClassOverridden: 1 };
    expect((await call())._body.statusCounts).toEqual(expected);
    // Same counts while a status filter is applied, so the summary doesn't collapse.
    const filtered = await call({ status: 'lotMismatch' });
    expect(filtered._body.statusCounts).toEqual(expected);
    expect(filtered._body.totals).toEqual({ count: 1, attention: 3 });
    // Other filters do narrow the counts.
    expect((await call({ search: 'coca' }))._body.statusCounts).toMatchObject({ stale: 0, lotMismatch: 1, incomeMissing: 0 });
  });

  it('rejects an unknown sort', async () => {
    expect((await call({ sort: 'value' }))._status).toBe(400);
  });

  it('rejects other methods', async () => {
    const res = await call({}, 'POST');
    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('sort=name lists every asset type in a deterministic order (group, symbol, id)', async () => {
    const res = await call({ sort: 'name' });
    expect(res._status).toBe(200);
    expect(res._body.items.map((r: any) => r.id)).toEqual([6, 2, 3, 4, 1, 7, 5]);
    expect(res._body.totals).toEqual({ count: 7, attention: 3 });
    expect(res._body.nextCursor).toBeNull();
    expect(res._body.portfolioCurrency).toBe('EUR');
    expect(res._body.detachedTermsCount).toBe(2);
  });

  it('scopes every query to the tenant', async () => {
    await call();
    for (const [args] of mockPrisma.portfolioItem.findMany.mock.calls) expect(args.where.tenantId).toBe('tenant-a');
    expect(mockPrisma.tenant.findUnique.mock.calls[0][0].where).toEqual({ id: 'tenant-a' });
    expect(mockPrisma.incomeTerms.count.mock.calls[0][0].where.tenantId).toBe('tenant-a');
    expect(mockPrisma.manualAssetValue.groupBy.mock.calls[0][0].where.tenantId).toBe('tenant-a');
  });

  it('hides closed positions (except debts) unless includeClosed=true', async () => {
    await call();
    expect(itemsCall().where.OR).toEqual([{ quantity: { not: 0 } }, { category: { type: 'Debt' } }]);
    vi.clearAllMocks();
    await call({ includeClosed: 'true' });
    expect(itemsCall().where.OR).toBeUndefined();
  });

  it('never loads manual-value history — only one grouped max(date) for the page', async () => {
    const res = await call();
    expect(JSON.stringify(itemsCall().select)).not.toContain('manualValues');
    expect(mockPrisma.manualAssetValue.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.manualAssetValue.groupBy.mock.calls[0][0]).toMatchObject({ by: ['assetId'], _max: { date: true } });
    expect(mockPrisma.manualAssetValue.groupBy.mock.calls[0][0].where.assetId.in.sort()).toEqual([3, 6]);
    for (const row of res._body.items) expect(row).not.toHaveProperty('manualValues');
  });

  it('returns lastManualValueDate and isPriceStale (>30 days, manual items only)', async () => {
    const rows = (await call())._body.items;
    const byId = (id: number) => rows.find((r: any) => r.id === id);
    expect(byId(3).lastManualValueDate).toBe(daysAgo(45).toISOString());
    expect(byId(3).isPriceStale).toBe(true);
    expect(byId(6).isPriceStale).toBe(false);
    expect(byId(1).lastManualValueDate).toBeNull();
    expect(byId(1).isPriceStale).toBe(false);
  });

  it('flags a manual item with no value at all as stale', async () => {
    mockPrisma.manualAssetValue.groupBy.mockResolvedValue([]);
    const rows = (await call())._body.items;
    expect(rows.find((r: any) => r.id === 3).isPriceStale).toBe(true);
  });

  it('converts stored values to the display currency without live pricing', async () => {
    const rows = (await call())._body.items;
    expect(rows.find((r: any) => r.id === 3).currentValueInDisplay).toBe(160000);
    expect(rows.find((r: any) => r.id === 3).currentValue).toBe('300000');
  });

  it('falls back to the native value when there is no USD value', async () => {
    mockPrisma.portfolioItem.findMany.mockImplementation(async (args: any) =>
      args.select.id ? [item({ id: 1, currency: 'EUR', currentValueInUSD: null, currentValue: '42' })] : []);
    const rows = (await call())._body.items;
    expect(rows[0].currentValueInDisplay).toBe(42);
  });

  it('computes status flags, asset class and income data status', async () => {
    const rows = (await call())._body.items;
    const byId = (id: number) => rows.find((r: any) => r.id === id);
    expect(byId(1)).toMatchObject({ displayName: 'Apple Inc', assetClass: 'STOCK', assetClassSource: 'AUTO', incomeDataStatus: 'AUTO', hasIncomeTerms: false });
    expect(byId(7)).toMatchObject({ assetClass: 'FUND', assetClassSource: 'OVERRIDE', accountName: 'Home' });
    expect(byId(2)).toMatchObject({ assetClass: 'INDEX_ETF', incomeAssetClass: 'ETF', incomeDataStatus: 'MISSING' });
    expect(byId(3)).toMatchObject({ assetClass: 'REAL_ESTATE', incomeDataStatus: 'MANUAL', hasIncomeTerms: true });
    expect(byId(4)).toMatchObject({ categoryType: 'Debt', hasDebtTerms: true, incomeDataStatus: 'NOT_APPLICABLE', incomeAssetClass: null });
    expect(byId(5)).toMatchObject({ hasDividendOverride: true, hasLotMismatch: true, incomeDataStatus: 'OVERRIDE' });
    expect(byId(6)).toMatchObject({ incomeAssetClass: null, incomeDataStatus: 'NOT_APPLICABLE' });
    // Internal fields never leak.
    expect(byId(1)).not.toHaveProperty('searchText');
    expect(byId(1)).not.toHaveProperty('currentValueInUSD');
  });

  it('classifies ETFs without composition data (plans without /etfs/world/composition)', async () => {
    mockPrisma.portfolioItem.findMany.mockImplementation(async (args: any) =>
      args.select.id
        ? [
            item({ id: 1, symbol: 'AGGH', category: cat({ name: 'ETFs', group: 'ETFs', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS' }) }),
            item({ id: 2, symbol: 'VWCE', category: cat({ name: 'ETFs', group: 'ETFs', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS' }) }),
          ]
        : []);
    mockPrisma.securityMaster.findMany.mockResolvedValue([
      { symbol: 'AGGH', name: 'iShares Core Global Aggregate Bond', assetType: 'ETF', etfComposition: null, dividendTrusted: false, recentDividends: null },
      { symbol: 'VWCE', name: 'Vanguard FTSE All-World', assetType: 'ETF', etfComposition: null, dividendTrusted: false, recentDividends: null },
    ]);
    const res = await call();
    expect(res._status).toBe(200);
    expect(res._body.items.map((r: any) => [r.symbol, r.assetClass])).toEqual([['AGGH', 'BOND_ETF'], ['VWCE', 'INDEX_ETF']]);
    expect((await call({ assetClass: 'BOND_ETF' }))._body.items.map((r: any) => r.id)).toEqual([1]);
  });

  it('reports NONE (not missing) for cash without terms', async () => {
    mockPrisma.portfolioItem.findMany.mockImplementation(async (args: any) =>
      args.select.id ? [item({ id: 1, symbol: 'EUR', category: cat({ name: 'Operating Cash', type: 'Asset', group: 'Cash', processingHint: 'CASH', defaultCategoryCode: 'OPERATING_CASH' }) })] : []);
    const rows = (await call())._body.items;
    expect(rows[0]).toMatchObject({ assetClass: 'CASH', incomeDataStatus: 'NONE' });
  });

  describe('filters', () => {
    it('type as a category group goes to SQL', async () => {
      await call({ type: 'Real Estate' });
      expect(itemsCall().where.category).toEqual({ type: { in: ['Investments', 'Asset', 'Debt'] }, group: 'Real Estate' });
    });

    it('type as a processingHint goes to SQL', async () => {
      await call({ type: 'MANUAL' });
      expect(itemsCall().where.category).toMatchObject({ processingHint: 'MANUAL' });
    });

    it('accountId goes to SQL and must be numeric', async () => {
      await call({ accountId: '11' });
      expect(itemsCall().where.accountId).toBe(11);
      expect((await call({ accountId: 'abc' }))._status).toBe(400);
    });

    it('id returns a single row (deep links) and skips facets', async () => {
      const res = await call({ id: '3' });
      expect(itemsCall().where.id).toBe(3);
      expect(itemsCall().where.OR).toBeUndefined();
      expect(res._body.facets).toBeUndefined();
      expect((await call({ id: 'x' }))._status).toBe(400);
    });

    it('assetClass filters in memory and is validated', async () => {
      const res = await call({ assetClass: 'STOCK' });
      expect(res._body.items.map((r: any) => r.id)).toEqual([5, 1]);
      expect((await call({ assetClass: 'BANANA' }))._status).toBe(400);
    });

    it('search matches symbol and SecurityMaster name, case-insensitively', async () => {
      expect((await call({ search: 'coca' }))._body.items.map((r: any) => r.id)).toEqual([5]);
      expect((await call({ search: 'LISBON' }))._body.items.map((r: any) => r.id)).toEqual([3]);
      expect((await call({ search: 'aapl' }))._body.totals.count).toBe(2);
    });

    it('status filters', async () => {
      const ids = async (status: string) => (await call({ status }))._body.items.map((r: any) => r.id);
      expect(await ids('stale')).toEqual([3]);
      expect(await ids('incomeMissing')).toEqual([2]);
      expect(await ids('dividendOverride')).toEqual([5]);
      expect(await ids('lotMismatch')).toEqual([5]);
      expect(await ids('assetClassOverridden')).toEqual([7]);
      expect((await call({ status: 'nope' }))._status).toBe(400);
    });

    it('stale filter looks up every manual item, not just the page', async () => {
      await call({ status: 'stale', limit: '1' });
      expect(mockPrisma.manualAssetValue.groupBy).toHaveBeenCalledTimes(1);
      expect(mockPrisma.manualAssetValue.groupBy.mock.calls[0][0].where.assetId.in.sort()).toEqual([3, 6]);
    });

    it('combines filters', async () => {
      const res = await call({ assetClass: 'STOCK', search: 'aapl', status: 'assetClassOverridden' });
      expect(res._body.items).toEqual([]);
      const res2 = await call({ assetClass: 'STOCK', search: 'ko', status: 'lotMismatch' });
      expect(res2._body.items.map((r: any) => r.id)).toEqual([5]);
    });
  });

  describe('pagination', () => {
    it('pages through with no duplicates or gaps', async () => {
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await call({ limit: '3', ...(cursor ? { cursor } : {}) });
        expect(res._status).toBe(200);
        expect(res._body.totals.count).toBe(7);
        seen.push(...res._body.items.map((r: any) => r.id));
        cursor = res._body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual([3, 2, 5, 6, 4, 1, 7]);
    });

    it('looks up the last manual value of every manual row once, and converts FX only for the page', async () => {
      const { convertCurrency } = await import('../../../utils/currencyConversion.js');
      const res = await call({ limit: '1' });
      expect(mockPrisma.manualAssetValue.groupBy).toHaveBeenCalledTimes(1);
      expect(mockPrisma.manualAssetValue.groupBy.mock.calls[0][0].where.assetId.in.sort()).toEqual([3, 6]);
      expect(res._body.items).toHaveLength(1);
      // One USD→display rate for the page, reused across rows.
      expect(vi.mocked(convertCurrency).mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('facets only on the first page', async () => {
      const first = await call({ limit: '3' });
      expect(first._body.facets.groups).toContainEqual({ group: 'Stocks', count: 3 });
      expect(first._body.facets.accounts).toEqual([{ id: 10, name: 'Broker' }, { id: 11, name: 'Home' }]);
      const second = await call({ limit: '3', cursor: first._body.nextCursor });
      expect(second._body.facets).toBeUndefined();
    });

    it('defaults to 50, clamps to 100 and rejects invalid limits', async () => {
      const many = Array.from({ length: 130 }, (_, i) => item({ id: i + 1, symbol: `S${String(i).padStart(3, '0')}` }));
      mockPrisma.portfolioItem.findMany.mockImplementation(async (args: any) => (args.select.id ? many : []));
      expect((await call())._body.items).toHaveLength(50);
      expect((await call({ limit: '500' }))._body.items).toHaveLength(100);
      expect((await call({ limit: '0' }))._status).toBe(400);
      expect((await call({ limit: 'ten' }))._status).toBe(400);
    });

    it('rejects a malformed cursor', async () => {
      expect((await call({ cursor: 'not-base64-number' }))._status).toBe(400);
    });

    it('returns an empty page past the end', async () => {
      const res = await call({ cursor: Buffer.from('99').toString('base64') });
      expect(res._body.items).toEqual([]);
      expect(res._body.nextCursor).toBeNull();
    });
  });

  it('returns 500 and reports to Sentry on a database error', async () => {
    mockPrisma.portfolioItem.findMany.mockRejectedValue(new Error('db down'));
    const res = await call();
    expect(res._status).toBe(500);
    expect(mockSentry.captureException).toHaveBeenCalled();
  });
});
