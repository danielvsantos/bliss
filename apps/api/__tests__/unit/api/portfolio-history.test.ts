/**
 * Unit tests for GET /api/portfolio/history
 *
 * Uses the mocked-handler pattern: withAuth, rate limiter, cors, Sentry,
 * Prisma, produceEvent, and currency conversion are all mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

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

const { mockProduceEvent } = vi.hoisted(() => ({
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

vi.mock('../../../utils/currencyConversion.js', () => ({
  batchFetchRates: vi.fn().mockResolvedValue(new Map()),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    portfolioValueHistory: {
      findFirst: vi.fn(),
      groupBy: vi.fn(),
    },
    portfolioItem: {
      findMany: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/portfolio/history.js';

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

describe('GET /api/portfolio/history', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns daily resolution for short date ranges', async () => {
    // Staleness check: latest record is today so no event fires
    const today = new Date();
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({
      date: today,
    });

    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });

    const historyDate = new Date('2026-03-15');
    mockPrisma.portfolioValueHistory.groupBy.mockResolvedValueOnce([
      { date: historyDate, assetId: 1, _sum: { valueInUSD: 1000 } },
    ]);
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
      { id: 1, category: { type: 'Investments', group: 'US Equities' } },
    ]);

    const from = '2026-03-01';
    const to = '2026-03-30';
    const req = makeReq({ query: { from, to } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.resolution).toBe('daily');
    expect(res._body.portfolioCurrency).toBe('USD');
    expect(res._body.history).toHaveLength(1);
    expect(res._body.history[0].totalUSD).toBe(1000);
  });

  it('returns monthly resolution for long date ranges', async () => {
    const today = new Date();
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({
      date: today,
    });

    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioValueHistory.groupBy.mockResolvedValueOnce([]);
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const from = '2024-01-01';
    const to = '2026-03-30';
    const req = makeReq({ query: { from, to } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.resolution).toBe('monthly');
  });

  it('triggers staleness check when history is old', async () => {
    // Latest record is yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    mockPrisma.portfolioValueHistory.findFirst
      .mockResolvedValueOnce({ date: yesterday }) // staleness check
      .mockResolvedValueOnce({ date: yesterday }); // earliest date for "no from" fallback

    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioValueHistory.groupBy.mockResolvedValueOnce([]);
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockProduceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PORTFOLIO_STALE_REVALUATION',
        tenantId: 'test-tenant-123',
      }),
    );
  });

  it('returns empty array when no history', async () => {
    // No records at all
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioValueHistory.groupBy.mockResolvedValueOnce([]);
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ query: { from: '2026-01-01', to: '2026-03-01' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.history).toEqual([]);
    // Should not trigger staleness event when no records exist
    expect(mockProduceEvent).not.toHaveBeenCalled();
  });

  // ── Holding scope (#131) ────────────────────────────────────────────────

  describe('holding scope', () => {
    function primeEmpty() {
      mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({ date: new Date() });
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
      mockPrisma.portfolioValueHistory.groupBy.mockResolvedValueOnce([]);
      mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);
    }

    async function run(query: Record<string, string>) {
      const req = makeReq({ query });
      const res = makeRes();
      await handler(req as NextApiRequest, res as unknown as NextApiResponse);
      return res;
    }

    it('leaves the Prisma filters unchanged when no scope is passed (regression)', async () => {
      primeEmpty();
      await run({ from: '2026-03-01', to: '2026-03-30', type: 'Investments,Asset', accountId: '5' });

      expect(mockPrisma.portfolioValueHistory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { asset: { tenantId: 'test-tenant-123', accountId: 5 } } }),
      );
      const where = mockPrisma.portfolioValueHistory.groupBy.mock.calls[0][0].where;
      expect(where.asset).toEqual({
        tenantId: 'test-tenant-123',
        accountId: 5,
        category: { type: { in: ['Investments', 'Asset'] } },
      });
    });

    it('scopes every asset filter to the symbol', async () => {
      mockPrisma.portfolioValueHistory.findFirst
        .mockResolvedValueOnce({ date: new Date() }) // staleness
        .mockResolvedValueOnce({ date: new Date('2026-01-10') }); // earliest
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
      mockPrisma.portfolioValueHistory.groupBy.mockResolvedValueOnce([]);
      mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

      const res = await run({ symbol: 'AAPL' });

      expect(res._status).toBe(200);
      const [staleCall, earliestCall] = mockPrisma.portfolioValueHistory.findFirst.mock.calls;
      expect(staleCall[0].where).toEqual({ asset: { tenantId: 'test-tenant-123', symbol: 'AAPL' } });
      expect(earliestCall[0].where).toEqual({ asset: { tenantId: 'test-tenant-123', symbol: 'AAPL' } });
      const where = mockPrisma.portfolioValueHistory.groupBy.mock.calls[0][0].where;
      expect(where.asset).toEqual({ tenantId: 'test-tenant-123', symbol: 'AAPL' });
    });

    it('starts ALL at the holding\'s own first valuation (late start)', async () => {
      const firstValuation = new Date('2026-06-01T00:00:00Z');
      mockPrisma.portfolioValueHistory.findFirst
        .mockResolvedValueOnce({ date: new Date() })
        .mockResolvedValueOnce({ date: firstValuation });
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
      mockPrisma.portfolioValueHistory.groupBy.mockResolvedValueOnce([]);
      mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

      await run({ symbol: 'NVDA', resolution: 'daily', to: '2026-06-30' });

      const where = mockPrisma.portfolioValueHistory.groupBy.mock.calls[0][0].where;
      expect(where.date.gte).toEqual(firstValuation);
    });

    it('combines symbol with accountId', async () => {
      primeEmpty();
      await run({ from: '2026-03-01', to: '2026-03-30', symbol: 'AAPL', accountId: '7' });
      const where = mockPrisma.portfolioValueHistory.groupBy.mock.calls[0][0].where;
      expect(where.asset).toEqual({ tenantId: 'test-tenant-123', accountId: 7, symbol: 'AAPL' });
    });

    it('trims the symbol', async () => {
      primeEmpty();
      await run({ from: '2026-03-01', to: '2026-03-30', symbol: '  MSFT ' });
      const where = mockPrisma.portfolioValueHistory.groupBy.mock.calls[0][0].where;
      expect(where.asset.symbol).toBe('MSFT');
    });

    it('scopes to a single item by itemId, still under the tenant', async () => {
      primeEmpty();
      await run({ from: '2026-03-01', to: '2026-03-30', itemId: '42' });
      const where = mockPrisma.portfolioValueHistory.groupBy.mock.calls[0][0].where;
      expect(where.asset).toEqual({ tenantId: 'test-tenant-123', id: 42 });
    });

    it('returns 400 when both symbol and itemId are passed', async () => {
      const res = await run({ symbol: 'AAPL', itemId: '1' });
      expect(res._status).toBe(400);
      expect(mockPrisma.portfolioValueHistory.groupBy).not.toHaveBeenCalled();
    });

    it.each(['abc', '1.5', '-3', '0', '12abc'])('returns 400 for itemId=%s', async (itemId) => {
      const res = await run({ itemId });
      expect(res._status).toBe(400);
      expect(mockPrisma.portfolioValueHistory.groupBy).not.toHaveBeenCalled();
    });

    it('returns 400 for an over-long symbol', async () => {
      const res = await run({ symbol: 'X'.repeat(51) });
      expect(res._status).toBe(400);
    });

    it('treats empty symbol / itemId as absent', async () => {
      primeEmpty();
      const res = await run({ from: '2026-03-01', to: '2026-03-30', symbol: '', itemId: '' });
      expect(res._status).toBe(200);
      const where = mockPrisma.portfolioValueHistory.groupBy.mock.calls[0][0].where;
      expect(where.asset).toEqual({ tenantId: 'test-tenant-123' });
    });

    it('returns 200 with an empty history for an unknown symbol', async () => {
      primeEmpty();
      const res = await run({ from: '2026-03-01', to: '2026-03-30', symbol: 'ZZZZ' });
      expect(res._status).toBe(200);
      expect(res._body.history).toEqual([]);
    });

    it('keeps the response shape for a scoped request', async () => {
      mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({ date: new Date() });
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
      const d = new Date('2026-03-15');
      mockPrisma.portfolioValueHistory.groupBy.mockResolvedValueOnce([
        { date: d, assetId: 1, _sum: { valueInUSD: 6000 } },
        { date: d, assetId: 2, _sum: { valueInUSD: 4000 } },
      ]);
      mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
        { id: 1, category: { type: 'Investments', group: 'Stocks' } },
        { id: 2, category: { type: 'Investments', group: 'Stocks' } },
      ]);

      const res = await run({ from: '2026-03-01', to: '2026-03-30', symbol: 'AAPL' });

      expect(res._body.history).toEqual([
        { date: '2026-03-15', totalUSD: 10000, Investments: { total: 10000, groups: { Stocks: 10000 } } },
      ]);
    });
  });
});
