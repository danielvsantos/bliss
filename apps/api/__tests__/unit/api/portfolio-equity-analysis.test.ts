/**
 * Unit tests for GET /api/portfolio/equity-analysis
 *
 * Uses the mocked-handler pattern: withAuth, rate limiter, cors, Sentry,
 * Prisma, valuation service, and currency conversion are all mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Decimal } from '@prisma/client/runtime/library';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

// Mock valuation service — return a live price
vi.mock('../../../services/valuation.service.js', () => ({
  calculateAssetCurrentValue: vi.fn().mockResolvedValue(new Decimal(150)),
}));

// Mock currency conversion — identity passthrough
vi.mock('../../../utils/currencyConversion.js', () => ({
  convertCurrency: vi.fn().mockImplementation(async (amount: any) => amount),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenant: {
      findUnique: vi.fn(),
    },
    portfolioItem: {
      findMany: vi.fn(),
    },
    securityMaster: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/portfolio/equity-analysis.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: {},
    cookies: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res._status = undefined;
  res._body = undefined;
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/portfolio/equity-analysis', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns sector groupings with weighted metrics', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });

    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
      {
        id: 1,
        symbol: 'AAPL',
        currency: 'USD',
        assetCurrency: 'USD',
        quantity: new Decimal(10),
        costBasis: new Decimal(1400),
        currentValue: new Decimal(1500),
        costBasisInUSD: new Decimal(1400),
        currentValueInUSD: new Decimal(1500),
        source: 'PLAID',
        category: { name: 'Stocks', group: 'US Equities', processingHint: 'API_STOCK' },
      },
    ]);

    mockPrisma.securityMaster.findMany.mockResolvedValueOnce([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        country: 'US',
        peRatio: new Decimal(28.5),
        dividendYield: new Decimal(0.005),
        trailingEps: new Decimal(6.2),
        latestEpsActual: new Decimal(1.46),
        latestEpsSurprise: new Decimal(0.04),
        week52High: new Decimal(200),
        week52Low: new Decimal(140),
        averageVolume: new Decimal(55000000),
        logoUrl: 'https://logo.clearbit.com/apple.com',
        // Trust gate: earnings/dividend fields are surfaced to the response
        // only when these flags are true. Set explicitly here so the fixture
        // exercises the populated path.
        earningsTrusted: true,
        dividendTrusted: true,
      },
    ]);

    const req = makeReq({ query: { groupBy: 'sector' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.portfolioCurrency).toBe('USD');
    expect(res._body.summary.holdingsCount).toBe(1);
    expect(res._body.summary.weightedPeRatio).toBeGreaterThan(0);
    expect(res._body.groups).toHaveLength(1);
    expect(res._body.groups[0].name).toBe('Technology');
    expect(res._body.groups[0].holdings).toHaveLength(1);
    expect(res._body.groups[0].holdings[0].symbol).toBe('AAPL');
  });

  it('returns empty when no stock holdings', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.summary.holdingsCount).toBe(0);
    expect(res._body.summary.totalEquityValue).toBe(0);
    expect(res._body.groups).toEqual([]);
  });

  it('hides earnings + dividend fields when trust flags are false', async () => {
    // Trust gate: when Twelve Data returned inconsistent data and the refresh
    // job marked the row earningsTrusted=false / dividendTrusted=false, the
    // API must null those fields out so the user sees `—` in the UI rather
    // than wrong numbers.
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });

    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
      {
        id: 1,
        symbol: 'AAPL',
        currency: 'USD',
        assetCurrency: 'USD',
        quantity: new Decimal(10),
        costBasis: new Decimal(1500),
        currentValue: new Decimal(1900),
        costBasisInUSD: new Decimal(1500),
        currentValueInUSD: new Decimal(1900),
        source: 'MANUAL',
        category: { name: 'Stocks', group: 'US Equities', processingHint: 'API_STOCK' },
      },
    ]);

    mockPrisma.securityMaster.findMany.mockResolvedValueOnce([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        country: 'US',
        peRatio: new Decimal(28.5),
        dividendYield: new Decimal(0.005),
        trailingEps: new Decimal(6.2),
        latestEpsActual: new Decimal(1.46),
        latestEpsSurprise: new Decimal(0.04),
        week52High: new Decimal(200),
        week52Low: new Decimal(140),
        averageVolume: new Decimal(55000000),
        logoUrl: null,
        earningsTrusted: false,
        dividendTrusted: false,
      },
    ]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const holding = res._body.groups[0].holdings[0];
    expect(holding.peRatio).toBeNull();
    expect(holding.dividendYield).toBeNull();
    expect(holding.trailingEps).toBeNull();
    expect(holding.latestEpsActual).toBeNull();
    expect(holding.latestEpsSurprise).toBeNull();
    // Quote-derived fields are NOT gated — they come from /quote, not earnings.
    expect(holding.week52High).toBe(200);
    expect(holding.week52Low).toBe(140);
    // Weighted metrics fall through to null when no holding has trusted data.
    expect(res._body.summary.weightedPeRatio).toBeNull();
    expect(res._body.summary.weightedDividendYield).toBeNull();
  });

  it('handles missing SecurityMaster data gracefully', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });

    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
      {
        id: 2,
        symbol: 'XYZ',
        currency: 'USD',
        assetCurrency: 'USD',
        quantity: new Decimal(5),
        costBasis: new Decimal(500),
        currentValue: new Decimal(600),
        costBasisInUSD: new Decimal(500),
        currentValueInUSD: new Decimal(600),
        source: 'MANUAL',
        category: { name: 'Stocks', group: 'US Equities', processingHint: 'API_STOCK' },
      },
    ]);

    // No SecurityMaster records for this symbol
    mockPrisma.securityMaster.findMany.mockResolvedValueOnce([]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.summary.holdingsCount).toBe(1);
    // Missing SM data should default to 'Unknown'
    const holding = res._body.groups[0].holdings[0];
    expect(holding.sector).toBe('Unknown');
    expect(holding.industry).toBe('Unknown');
    expect(holding.peRatio).toBeNull();
    expect(holding.dividendYield).toBeNull();
    // Weighted metrics should be null when no PE data
    expect(res._body.summary.weightedPeRatio).toBeNull();
  });

  // ── Passive Income #77: ETFs in Equity Analysis ──────────────────────────
  const item = (overrides: any = {}) => ({
    id: 1,
    symbol: 'AAPL',
    currency: 'USD',
    assetCurrency: 'USD',
    quantity: new Decimal(10),
    costBasis: new Decimal(1000),
    currentValue: new Decimal(1500),
    costBasisInUSD: new Decimal(1000),
    currentValueInUSD: new Decimal(1500),
    source: 'SYNCED',
    category: { name: 'Stocks', group: 'Stocks', processingHint: 'API_STOCK' },
    incomeTerms: null,
    ...overrides,
  });
  const sm = (overrides: any = {}) => ({
    symbol: 'AAPL', name: 'Apple', sector: 'Technology', industry: 'Consumer Electronics', country: 'US',
    assetType: 'Common Stock', peRatio: new Decimal(30), trailingEps: new Decimal(5),
    dividendYield: new Decimal(0.01), earningsTrusted: true, dividendTrusted: true,
    ...overrides,
  });

  it('includes ETFs as "Diversified", keeps P/E stock-only and skips non-ETF funds', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
      item(),
      item({ id: 2, symbol: 'VWCE', category: { name: 'ETFs', group: 'ETFs', processingHint: 'API_FUND' } }),
      item({ id: 3, symbol: 'VFIAX', category: { name: 'Funds', group: 'Funds', processingHint: 'API_FUND' } }),
    ]);
    mockPrisma.securityMaster.findMany.mockResolvedValueOnce([
      sm(),
      // UCITS profile values are misleading — must be ignored.
      sm({ symbol: 'VWCE', sector: 'Basic Materials', country: 'Netherlands', assetType: 'ETF', peRatio: new Decimal(3), dividendYield: new Decimal(0) }),
      sm({ symbol: 'VFIAX', assetType: 'Mutual Fund' }),
    ]);

    const res = makeRes();
    await handler(makeReq({ query: { groupBy: 'country' } }) as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.summary.holdingsCount).toBe(2);
    const names = res._body.groups.map((g: any) => g.name);
    expect(names).toEqual(expect.arrayContaining(['US', 'Diversified']));
    expect(names).not.toContain('Unknown');
    expect(names).not.toContain('Netherlands');
    const etf = res._body.groups.find((g: any) => g.name === 'Diversified').holdings[0];
    expect(etf.symbol).toBe('VWCE');
    expect(etf.assetType).toBe('ETF');
    expect(etf.peRatio).toBeNull();
    expect(etf.sector).toBe('Diversified');
    // Weighted P/E comes from the stock only.
    expect(res._body.summary.weightedPeRatio).toBe(30);
  });

  it('uses the dividend override for yield and merges same-symbol holdings', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    // Live price is mocked at 150 → value 1500 per 10 units.
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
      item({ incomeTerms: { incomeType: 'DIVIDEND', isDistributing: true, dividendPerUnit: new Decimal(6), currency: 'USD' } }),
      item({ id: 2, incomeTerms: { incomeType: 'DIVIDEND', isDistributing: false, dividendPerUnit: null, currency: 'USD' } }),
    ]);
    mockPrisma.securityMaster.findMany.mockResolvedValueOnce([sm()]);

    const res = makeRes();
    await handler(makeReq({}) as NextApiRequest, res as unknown as NextApiResponse);

    const holding = res._body.groups[0].holdings[0];
    expect(res._body.summary.holdingsCount).toBe(1);
    // (6 × 10 + 0) / (1500 + 1500) = 0.02
    expect(holding.dividendYield).toBeCloseTo(0.02, 6);
    expect(holding).not.toHaveProperty('annualDividendUSD');
  });
});

// ---------------------------------------------------------------------------
// Asset classes & ETF look-through (#79)
// ---------------------------------------------------------------------------

describe('GET /api/portfolio/equity-analysis — asset classes & look-through (#79)', () => {
  const QQQ_COMPOSITION = {
    sectors: [{ sector: 'Technology', weight: 0.5915 }, { sector: 'Communication Services', weight: 0.1581 }],
    countries: [],
    assetAllocation: { stocks: 0.9995, cash: 0.0005, bonds: 0 },
  };
  const VWCE_COMPOSITION = {
    sectors: [{ sector: 'Technology', weight: 0.27 }],
    countries: [{ country: 'United States', weight: 0.6 }],
    assetAllocation: { stocks: 1, bonds: 0 },
  };

  const base = {
    currency: 'USD', assetCurrency: 'USD', quantity: new Decimal(10),
    costBasis: new Decimal(1000), costBasisInUSD: new Decimal(1000),
    source: 'SYNCED', incomeTerms: null, assetClassOverride: null,
  };
  // Live price is mocked at 150 → 1500 per 10 units for every synced item.
  const ko = { ...base, id: 1, symbol: 'KO', currentValue: new Decimal(1500), currentValueInUSD: new Decimal(1500),
    category: { name: 'Stocks', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK', defaultCategoryCode: 'STOCKS' } };
  const qqq = { ...base, id: 2, symbol: 'QQQ', currentValue: new Decimal(1500), currentValueInUSD: new Decimal(1500),
    category: { name: 'ETFs', group: 'ETFs', type: 'Investments', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS' } };

  const koSm = { symbol: 'KO', name: 'Coca-Cola', sector: 'Consumer Defensive', industry: 'Beverages', country: 'United States',
    assetType: 'Common Stock', peRatio: new Decimal(25), earningsTrusted: true, dividendTrusted: false };
  const qqqSm = { symbol: 'QQQ', name: 'Invesco QQQ Trust', assetType: 'ETF', etfComposition: QQQ_COMPOSITION };

  async function run(query: Record<string, string> = {}, items: any[] = [ko, qqq], sms: any[] = [koSm, qqqSm]) {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce(items);
    mockPrisma.securityMaster.findMany.mockResolvedValueOnce(sms);
    const res = makeRes();
    await handler(makeReq({ query }) as NextApiRequest, res as unknown as NextApiResponse);
    return res;
  }
  const values = (groups: any[]) => Object.fromEntries(groups.map((g) => [g.name, g.totalValue]));

  it('queries only stock/fund holdings', async () => {
    await run();
    const { where, select } = mockPrisma.portfolioItem.findMany.mock.calls[0][0];
    expect(where.category).toEqual({ processingHint: { in: ['API_STOCK', 'API_FUND'] } });
    expect(where.tenantId).toBe('test-tenant-123');
    expect(select.assetClassOverride).toBe(true);
    expect(select.incomeTerms.select.issuerType).toBe(true);
  });

  it('adds asset class fields and the ETF composition to each holding', async () => {
    const res = await run();
    const byS = Object.fromEntries(res._body.holdings.map((h: any) => [h.symbol, h]));
    expect(byS.KO).toMatchObject({ assetClass: 'STOCK', assetClassSource: 'AUTO', autoAssetClass: 'STOCK', composition: null, itemIds: [1] });
    expect(byS.QQQ.assetClass).toBe('INDEX_ETF');
    expect(byS.QQQ.composition.sectors[0]).toEqual({ sector: 'Technology', weight: 0.5915 });
    expect(byS.QQQ.sector).toBe('Diversified'); // the row itself is not split
  });

  it('looks through ETFs in the sector view by default', async () => {
    const res = await run({ groupBy: 'sector' });
    expect(res._body.lookThrough).toBe(true);
    expect(res._body.lookThroughAvailable).toBe(true); // QQQ has sector weights
    const groups = values(res._body.groups);
    expect(groups.Technology).toBeCloseTo(1500 * 0.5915, 1);
    expect(groups['Consumer Defensive']).toBe(1500);
    expect(groups.Other).toBeCloseTo(1500 * (1 - 0.5915 - 0.1581), 1);
    expect(groups.Diversified).toBeUndefined();
    const tech = res._body.groups.find((g: any) => g.name === 'Technology');
    expect(tech.weight).toBeCloseTo(0.5915 / 2, 4);
    expect(tech.holdings[0].symbol).toBe('QQQ');
    // Holdings are still listed once each; weighted P/E is unchanged.
    expect(res._body.holdings).toHaveLength(2);
    expect(res._body.summary.weightedPeRatio).toBe(25);
  });

  it('keeps QQQ "Diversified" in the country view (empty allocation) and the industry view', async () => {
    const res = await run();
    expect(values(res._body.groupings.country)).toEqual({ Diversified: 1500, 'United States': 1500 });
    expect(values(res._body.groupings.industry)).toEqual({ Diversified: 1500, Beverages: 1500 });
  });

  it('uses the country allocation when present', async () => {
    const res = await run({ groupBy: 'country' }, [ko, { ...qqq, symbol: 'VWCE' }],
      [koSm, { symbol: 'VWCE', name: 'Vanguard FTSE All-World', assetType: 'ETF', etfComposition: VWCE_COMPOSITION }]);
    const groups = values(res._body.groups);
    expect(groups['United States']).toBeCloseTo(1500 + 900, 1);
    expect(groups.Other).toBeCloseTo(600, 1);
  });

  it('reports look-through as unavailable when no ETF has composition data', async () => {
    const res = await run({}, [ko, qqq], [koSm, { ...qqqSm, etfComposition: null }]);
    expect(res._body.lookThroughAvailable).toBe(false);
    expect(values(res._body.groups)).toEqual({ Diversified: 1500, 'Consumer Defensive': 1500 });
  });

  it('with lookThrough=false matches the #77 "Diversified" buckets', async () => {
    const res = await run({ groupBy: 'sector', lookThrough: 'false' });
    expect(res._body.lookThrough).toBe(false);
    expect(values(res._body.groups)).toEqual({ Diversified: 1500, 'Consumer Defensive': 1500 });
  });

  it('groups by asset class', async () => {
    const res = await run({ groupBy: 'assetClass' });
    expect(values(res._body.groups)).toEqual({ STOCK: 1500, INDEX_ETF: 1500 });
  });

  it('returns only equity data (no portfolio composition or fixed income)', async () => {
    const res = await run();
    expect(res._body).not.toHaveProperty('composition');
    expect(res._body).not.toHaveProperty('fixedIncome');
  });

  it('honours an asset class override and lets it win the same-symbol merge', async () => {
    const res = await run({ groupBy: 'assetClass' }, [ko, { ...ko, id: 9, assetClassOverride: 'FUND' }], [koSm]);
    expect(res._body.holdings).toHaveLength(1);
    expect(res._body.holdings[0]).toMatchObject({
      assetClass: 'FUND', assetClassSource: 'OVERRIDE', autoAssetClass: 'STOCK', itemIds: [1, 9],
    });
    expect(values(res._body.groups)).toEqual({ FUND: 3000 });
  });

  it('places a stock overridden to a non-equity class by its own sector', async () => {
    const res = await run({}, [{ ...ko, assetClassOverride: 'GOV_BOND' }], [koSm]);
    expect(values(res._body.groups)).toEqual({ 'Consumer Defensive': 1500 });
    expect(res._body.holdings[0].assetClass).toBe('GOV_BOND');
  });

  it('rejects an unknown groupBy', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { groupBy: 'nope' } }) as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(400);
  });
});
