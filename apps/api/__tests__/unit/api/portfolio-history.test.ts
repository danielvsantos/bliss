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
    transaction: {
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
  mockPrisma.portfolioValueHistory.groupBy.mockReset();
  mockPrisma.portfolioValueHistory.groupBy.mockResolvedValue([]);
  mockPrisma.transaction.findMany.mockReset();
  mockPrisma.transaction.findMany.mockResolvedValue([]);
});

/** The main history query (by date + asset), not the per-asset bounds lookup. */
function mainGroupByArgs() {
  const call = mockPrisma.portfolioValueHistory.groupBy.mock.calls
    .find(([args]) => args.by.includes('date'));
  return call![0];
}

/** Sample dates of a weekly/monthly response, as YYYY-MM-DD strings. */
function sampledDays(): string[] {
  return mainGroupByArgs().where.date.in.map((d: Date) => d.toISOString().split('T')[0]);
}

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

  it('returns weekly resolution for a 2-year range, with a bounded sample count (#137)', async () => {
    const today = new Date();
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({
      date: today,
    });

    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const from = '2024-01-01';
    const to = '2026-01-01';
    const req = makeReq({ query: { from, to } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.resolution).toBe('weekly');
    const days = sampledDays();
    // ~105 Saturdays + first and last day — one row per week, not per day.
    expect(days.length).toBeGreaterThanOrEqual(104);
    expect(days.length).toBeLessThanOrEqual(110);
    expect(days[0]).toBe('2024-01-01');
    expect(days[days.length - 1]).toBe('2026-01-01');
    expect(new Set(days).size).toBe(days.length);
  });

  it('samples ALL (no from) weekly when the history is 2 years long', async () => {
    mockPrisma.portfolioValueHistory.findFirst
      .mockResolvedValueOnce({ date: new Date() }) // staleness
      .mockResolvedValueOnce({ date: new Date('2024-06-01T00:00:00Z') }); // earliest
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const res = makeRes();
    await handler(makeReq({ query: { to: '2026-06-01' } }) as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._body.resolution).toBe('weekly');
    const days = sampledDays();
    expect(days[0]).toBe('2024-06-01');
    expect(days.length).toBeLessThanOrEqual(110);
  });

  it('returns monthly resolution beyond ~5 years', async () => {
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({ date: new Date() });
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const res = makeRes();
    await handler(makeReq({ query: { from: '2018-01-01', to: '2026-03-30' } }) as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._body.resolution).toBe('monthly');
    expect(sampledDays().length).toBeLessThanOrEqual(102);
  });

  it('adds each holding\'s first/last valuation and trade days as sample points (#137)', async () => {
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({ date: new Date() });
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);
    // Bounds lookup: a copy trade bought Tue 20 Jan 2026; crypto from 2025-02-12.
    mockPrisma.portfolioValueHistory.groupBy.mockImplementation(async (args: { by: string[] }) => (
      args.by.includes('date') ? [] : [
        { assetId: 1, _min: { date: new Date('2026-01-20T00:00:00Z') }, _max: { date: new Date('2026-03-30T00:00:00Z') } },
        { assetId: 2, _min: { date: new Date('2025-02-12T00:00:00Z') }, _max: { date: new Date('2026-03-30T00:00:00Z') } },
      ]
    ));
    // Crypto sold on Wed 9 Jul and rebought on Fri 29 Aug 2025.
    mockPrisma.transaction.findMany.mockResolvedValueOnce([
      { transaction_date: new Date('2025-07-09T00:00:00Z') },
      { transaction_date: new Date('2025-08-29T00:00:00Z') },
    ]);

    const res = makeRes();
    await handler(
      makeReq({ query: { from: '2025-01-01', to: '2026-03-30', type: 'Investments' } }) as NextApiRequest,
      res as unknown as NextApiResponse,
    );

    expect(res._status).toBe(200);
    const days = sampledDays();
    for (const d of ['2026-01-20', '2025-02-12', '2025-07-09', '2025-08-29']) {
      expect(days).toContain(d);
    }
    // Each trade day also samples the day before (#147): the sell-off drops and
    // the rebuy rises within one day instead of ramping from the last Saturday.
    expect(days).toContain('2025-07-08');
    expect(days).toContain('2025-08-28');
    expect(days).toEqual([...days].sort());

    // Trade days only come from traded (stock / crypto / fund) holdings in scope.
    const txWhere = mockPrisma.transaction.findMany.mock.calls[0][0].where;
    expect(txWhere.tenantId).toBe('test-tenant-123');
    expect(txWhere.portfolioItem).toEqual({
      tenantId: 'test-tenant-123',
      category: {
        type: { in: ['Investments'] },
        processingHint: { in: ['API_STOCK', 'API_CRYPTO', 'API_FUND'] },
      },
    });
  });

  it('adds the day before each trade day only inside the range, keeping the count bounded (#147)', async () => {
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({ date: new Date() });
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);
    // 400 trade days (the cap) every other day from the first day of the range.
    const trades = Array.from({ length: 400 }, (_, i) => ({
      transaction_date: new Date(Date.UTC(2024, 0, 1 + 2 * i)),
    }));
    mockPrisma.transaction.findMany.mockResolvedValueOnce(trades);

    const res = makeRes();
    await handler(makeReq({ query: { from: '2024-01-01', to: '2026-01-01' } }) as NextApiRequest, res as unknown as NextApiResponse);

    const days = sampledDays();
    // A trade on the first day of the range adds no day before it.
    expect(days[0]).toBe('2024-01-01');
    expect(days).not.toContain('2023-12-31');
    expect(days).toContain('2024-01-03');
    expect(days).toContain('2024-01-02');
    expect(new Set(days).size).toBe(days.length);
    // Weekly samples + at most 2 × 400 trade-driven dates.
    expect(days.length).toBeLessThanOrEqual(110 + 800);
  });

  it('drops trade days (keeps holding bounds) when there are too many', async () => {
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({ date: new Date() });
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);
    const trades = Array.from({ length: 401 }, (_, i) => ({
      transaction_date: new Date(Date.UTC(2024, 0, 2 + i)),
    }));
    mockPrisma.transaction.findMany.mockResolvedValueOnce(trades);

    const res = makeRes();
    await handler(makeReq({ query: { from: '2024-01-01', to: '2026-01-01' } }) as NextApiRequest, res as unknown as NextApiResponse);

    expect(sampledDays().length).toBeLessThanOrEqual(110);
  });

  it('does not run the event-date lookups for daily ranges', async () => {
    mockPrisma.portfolioValueHistory.findFirst.mockResolvedValue({ date: new Date() });
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const res = makeRes();
    await handler(makeReq({ query: { from: '2026-03-01', to: '2026-03-30' } }) as NextApiRequest, res as unknown as NextApiResponse);

    expect(mockPrisma.transaction.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.portfolioValueHistory.groupBy).toHaveBeenCalledTimes(1);
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
      const where = mainGroupByArgs().where;
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
      const where = mainGroupByArgs().where;
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

      const where = mainGroupByArgs().where;
      expect(where.date.gte).toEqual(firstValuation);
    });

    it('combines symbol with accountId', async () => {
      primeEmpty();
      await run({ from: '2026-03-01', to: '2026-03-30', symbol: 'AAPL', accountId: '7' });
      const where = mainGroupByArgs().where;
      expect(where.asset).toEqual({ tenantId: 'test-tenant-123', accountId: 7, symbol: 'AAPL' });
    });

    it('trims the symbol', async () => {
      primeEmpty();
      await run({ from: '2026-03-01', to: '2026-03-30', symbol: '  MSFT ' });
      const where = mainGroupByArgs().where;
      expect(where.asset.symbol).toBe('MSFT');
    });

    it('scopes to a single item by itemId, still under the tenant', async () => {
      primeEmpty();
      await run({ from: '2026-03-01', to: '2026-03-30', itemId: '42' });
      const where = mainGroupByArgs().where;
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
      const where = mainGroupByArgs().where;
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
