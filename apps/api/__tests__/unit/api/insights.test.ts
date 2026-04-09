/**
 * Unit tests for /api/insights (v1 — tiered architecture).
 *
 * Mocked handler pattern: withAuth, cors, rateLimit, Sentry, Prisma, and
 * global fetch are all mocked so we test handler logic in isolation.
 *
 * Coverage:
 *   - GET  /api/insights  → tier/category/periodKey/includeDismissed filters,
 *                           tierSummary aggregation, categoryCounts shape
 *   - PUT  /api/insights  → dismiss / restore (ownership check)
 *   - POST /api/insights  → fire-and-forget to backend with tier params
 *   - 405 method guard
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

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    insight: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

// Mock global fetch for POST (fire-and-forget to backend)
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import handler from '../../../pages/api/insights.js';

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

/**
 * Seed all Prisma mocks with a default "happy path" set of resolutions so
 * individual tests can focus on their specific assertions.
 */
function seedPrismaDefaults(opts: {
  insights?: unknown[];
  total?: number;
  latestByTier?: unknown[];
  categoryCounts?: unknown[];
} = {}) {
  mockPrisma.insight.findMany.mockResolvedValueOnce(opts.insights ?? []);
  mockPrisma.insight.count.mockResolvedValueOnce(opts.total ?? 0);
  // First groupBy call is latestByTier; second is categoryCounts.
  mockPrisma.insight.groupBy.mockResolvedValueOnce(opts.latestByTier ?? []);
  mockPrisma.insight.groupBy.mockResolvedValueOnce(opts.categoryCounts ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/insights
// ---------------------------------------------------------------------------

describe('GET /api/insights', () => {
  it('returns insights with default filters (excludes dismissed)', async () => {
    const insights = [
      {
        id: 'ins-1',
        lens: 'SPENDING_VELOCITY',
        tier: 'DAILY',
        category: 'SPENDING',
        periodKey: '2026-04-09',
        severity: 'WARNING',
        title: 'Spending up',
        priority: 3,
        dismissed: false,
      },
    ];
    seedPrismaDefaults({
      insights,
      total: 1,
      latestByTier: [
        {
          tier: 'DAILY',
          _max: { date: new Date('2026-04-09T00:00:00Z'), createdAt: new Date('2026-04-09T06:05:00Z') },
        },
      ],
      categoryCounts: [{ category: 'SPENDING', _count: { id: 1 } }],
    });

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.insights).toEqual(insights);
    expect(res._body.total).toBe(1);
    expect(res._body).not.toHaveProperty('latestBatchDate');
    expect(res._body.tierSummary.DAILY).toEqual({
      latestDate: new Date('2026-04-09T00:00:00Z'),
      latestCreatedAt: new Date('2026-04-09T06:05:00Z'),
    });
    expect(res._body.categoryCounts).toEqual({ SPENDING: 1 });

    // Default: dismissed=false, limit=20, offset=0, no tier/category/periodKey filters
    expect(mockPrisma.insight.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 'test-tenant-123',
        dismissed: false,
      }),
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      skip: 0,
    });

    // Assert neither tier nor category leaked into the where clause when unset
    const whereArg = (mockPrisma.insight.findMany.mock.calls[0][0] as any).where;
    expect(whereArg.tier).toBeUndefined();
    expect(whereArg.category).toBeUndefined();
    expect(whereArg.periodKey).toBeUndefined();
  });

  it('applies lens filter', async () => {
    seedPrismaDefaults();

    const req = makeReq({ method: 'GET', query: { lens: 'SAVINGS_RATE' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.insight.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ lens: 'SAVINGS_RATE' }),
      orderBy: expect.any(Array),
      take: 20,
      skip: 0,
    });
  });

  it('applies tier filter when tier is valid', async () => {
    seedPrismaDefaults();

    const req = makeReq({ method: 'GET', query: { tier: 'MONTHLY' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const whereArg = (mockPrisma.insight.findMany.mock.calls[0][0] as any).where;
    expect(whereArg.tier).toBe('MONTHLY');
  });

  it('ignores tier filter when tier is not in VALID_TIERS', async () => {
    seedPrismaDefaults();

    const req = makeReq({ method: 'GET', query: { tier: 'BOGUS' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const whereArg = (mockPrisma.insight.findMany.mock.calls[0][0] as any).where;
    expect(whereArg.tier).toBeUndefined();
  });

  it('applies category filter when category is valid', async () => {
    seedPrismaDefaults();

    const req = makeReq({ method: 'GET', query: { category: 'PORTFOLIO' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const whereArg = (mockPrisma.insight.findMany.mock.calls[0][0] as any).where;
    expect(whereArg.category).toBe('PORTFOLIO');
  });

  it('ignores category filter when category is not in VALID_CATEGORIES', async () => {
    seedPrismaDefaults();

    const req = makeReq({ method: 'GET', query: { category: 'BOGUS' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const whereArg = (mockPrisma.insight.findMany.mock.calls[0][0] as any).where;
    expect(whereArg.category).toBeUndefined();
  });

  it('applies periodKey filter', async () => {
    seedPrismaDefaults();

    const req = makeReq({ method: 'GET', query: { periodKey: '2026-Q1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const whereArg = (mockPrisma.insight.findMany.mock.calls[0][0] as any).where;
    expect(whereArg.periodKey).toBe('2026-Q1');
  });

  it('includes dismissed insights when includeDismissed=true', async () => {
    seedPrismaDefaults();

    const req = makeReq({ method: 'GET', query: { includeDismissed: 'true' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const whereArg = (mockPrisma.insight.findMany.mock.calls[0][0] as any).where;
    expect(whereArg.dismissed).toBeUndefined();
  });

  it('applies combined filters (tier + category + periodKey)', async () => {
    seedPrismaDefaults();

    const req = makeReq({
      method: 'GET',
      query: { tier: 'QUARTERLY', category: 'SPENDING', periodKey: '2026-Q1' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const whereArg = (mockPrisma.insight.findMany.mock.calls[0][0] as any).where;
    expect(whereArg).toMatchObject({
      tier: 'QUARTERLY',
      category: 'SPENDING',
      periodKey: '2026-Q1',
      dismissed: false,
      tenantId: 'test-tenant-123',
    });
  });

  it('aggregates latestByTier groupBy results into tierSummary', async () => {
    seedPrismaDefaults({
      latestByTier: [
        {
          tier: 'DAILY',
          _max: { date: new Date('2026-04-09T00:00:00Z'), createdAt: new Date('2026-04-09T06:00:00Z') },
        },
        {
          tier: 'MONTHLY',
          _max: { date: new Date('2026-03-31T00:00:00Z'), createdAt: new Date('2026-04-02T06:00:00Z') },
        },
      ],
    });

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(Object.keys(res._body.tierSummary)).toEqual(['DAILY', 'MONTHLY']);
    expect(res._body.tierSummary.DAILY.latestDate).toEqual(new Date('2026-04-09T00:00:00Z'));
    expect(res._body.tierSummary.MONTHLY.latestCreatedAt).toEqual(new Date('2026-04-02T06:00:00Z'));
  });

  it('reduces categoryCounts groupBy into a flat map', async () => {
    seedPrismaDefaults({
      categoryCounts: [
        { category: 'SPENDING', _count: { id: 12 } },
        { category: 'PORTFOLIO', _count: { id: 8 } },
        { category: 'NET_WORTH', _count: { id: 3 } },
      ],
    });

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.categoryCounts).toEqual({
      SPENDING: 12,
      PORTFOLIO: 8,
      NET_WORTH: 3,
    });
  });

  it('respects custom limit and offset', async () => {
    seedPrismaDefaults();

    const req = makeReq({ method: 'GET', query: { limit: '50', offset: '100' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(mockPrisma.insight.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, skip: 100 }),
    );
  });
});

// ---------------------------------------------------------------------------
// PUT /api/insights
// ---------------------------------------------------------------------------

describe('PUT /api/insights', () => {
  it('updates dismissed status when ownership check passes', async () => {
    const insight = { id: 'ins-1', tenantId: 'test-tenant-123', dismissed: false };
    mockPrisma.insight.findFirst.mockResolvedValueOnce(insight);
    mockPrisma.insight.update.mockResolvedValueOnce({ ...insight, dismissed: true });

    const req = makeReq({
      method: 'PUT',
      body: { insightId: 'ins-1', dismissed: true },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.insight.findFirst).toHaveBeenCalledWith({
      where: { id: 'ins-1', tenantId: 'test-tenant-123' },
    });
    expect(mockPrisma.insight.update).toHaveBeenCalledWith({
      where: { id: 'ins-1' },
      data: { dismissed: true },
    });
  });

  it('returns 400 when insightId is missing', async () => {
    const req = makeReq({ method: 'PUT', body: { dismissed: true } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(mockPrisma.insight.update).not.toHaveBeenCalled();
  });

  it('returns 400 when dismissed is not a boolean', async () => {
    const req = makeReq({ method: 'PUT', body: { insightId: 'ins-1', dismissed: 'yes' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(mockPrisma.insight.update).not.toHaveBeenCalled();
  });

  it('returns 404 when insight does not belong to tenant', async () => {
    mockPrisma.insight.findFirst.mockResolvedValueOnce(null);

    const req = makeReq({
      method: 'PUT',
      body: { insightId: 'ins-1', dismissed: true },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(mockPrisma.insight.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/insights
// ---------------------------------------------------------------------------

describe('POST /api/insights', () => {
  it('returns 202 and fires-and-forgets to backend with default DAILY tier', async () => {
    const req = makeReq({ method: 'POST', body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    expect(res._body).toMatchObject({
      message: 'Insight generation started',
      tier: 'DAILY',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/insights/generate');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBeDefined();
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ tenantId: 'test-tenant-123', force: false });
  });

  it('forwards tier, year, month, and force params in fetch body', async () => {
    const req = makeReq({
      method: 'POST',
      body: { tier: 'MONTHLY', year: 2026, month: 3, force: true },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    expect(res._body.tier).toBe('MONTHLY');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      tenantId: 'test-tenant-123',
      tier: 'MONTHLY',
      year: 2026,
      month: 3,
      force: true,
    });
  });

  it('forwards QUARTERLY params (year, quarter)', async () => {
    const req = makeReq({
      method: 'POST',
      body: { tier: 'QUARTERLY', year: 2026, quarter: 1 },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    expect(res._body.tier).toBe('QUARTERLY');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      tier: 'QUARTERLY',
      year: 2026,
      quarter: 1,
    });
  });

  it('forwards ANNUAL params (year, force)', async () => {
    const req = makeReq({
      method: 'POST',
      body: { tier: 'ANNUAL', year: 2025, force: 'true' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ tier: 'ANNUAL', year: 2025, force: true });
  });

  it('forwards PORTFOLIO tier without period params', async () => {
    const req = makeReq({ method: 'POST', body: { tier: 'PORTFOLIO' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tier).toBe('PORTFOLIO');
    expect(body.year).toBeUndefined();
    expect(body.month).toBeUndefined();
  });

  it('returns 400 when tier is invalid', async () => {
    const req = makeReq({ method: 'POST', body: { tier: 'BOGUS' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/Invalid tier/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Method validation
// ---------------------------------------------------------------------------

describe('Method validation', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'DELETE' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PUT', 'POST']);
  });
});
