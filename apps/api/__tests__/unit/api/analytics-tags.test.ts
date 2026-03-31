/**
 * Unit tests for GET /api/analytics/tags
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * withAuth, rate limiter, cors, Sentry, and Prisma are all mocked so we can
 * test the handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

// Mock rate limiter
vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

// Inject a test user via withAuth mock
const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

// Mock cors to no-op
vi.mock('../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

// Mock Sentry
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

// Mock Prisma — use vi.hoisted() so the object is available before vi.mock hoisting
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tagAnalyticsCacheMonthly: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/analytics/tags.js';

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

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Method validation
// ---------------------------------------------------------------------------

describe('Method validation', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });
});

// ---------------------------------------------------------------------------
// Query param validation
// ---------------------------------------------------------------------------

describe('Query param validation', () => {
  it('returns 400 when no tagIds are provided', async () => {
    const req = makeReq({ method: 'GET', query: { startMonth: '2026-01', endMonth: '2026-03' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'At least one tagId is required' });
  });

  it('returns 400 when tagIds are non-numeric', async () => {
    const req = makeReq({
      method: 'GET',
      query: { 'tagIds[]': ['abc', 'def'], startMonth: '2026-01', endMonth: '2026-03' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'At least one tagId is required' });
  });

  it('returns 200 for month view without startMonth/endMonth (returns all data)', async () => {
    mockPrisma.tagAnalyticsCacheMonthly.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      method: 'GET',
      query: { 'tagIds[]': ['5'], view: 'month' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ currency: 'USD', view: 'month', tags: {} });
    // Should query without date filters
    expect(mockPrisma.tagAnalyticsCacheMonthly.findMany).toHaveBeenCalledWith({
      where: expect.not.objectContaining({ OR: expect.anything() }),
    });
  });

  it('returns 400 when quarter view is missing startQuarter/endQuarter', async () => {
    const req = makeReq({
      method: 'GET',
      query: { 'tagIds[]': ['5'], view: 'quarter' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'startQuarter and endQuarter are required for quarter view' });
  });
});

// ---------------------------------------------------------------------------
// Successful month view
// ---------------------------------------------------------------------------

describe('GET /api/analytics/tags — month view', () => {
  it('returns 200 with grouped tag analytics', async () => {
    const mockRows = [
      {
        tagId: 5, year: 2026, month: 1, currency: 'USD', country: 'US',
        type: 'Expense', group: 'Dining', categoryId: 10, categoryName: 'Sushi',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 450 }, balance: { toNumber: () => -450 },
      },
      {
        tagId: 5, year: 2026, month: 1, currency: 'USD', country: 'US',
        type: 'Expense', group: 'Transport', categoryId: 20, categoryName: 'Train',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 200 }, balance: { toNumber: () => -200 },
      },
      {
        tagId: 5, year: 2026, month: 2, currency: 'USD', country: 'US',
        type: 'Expense', group: 'Dining', categoryId: 11, categoryName: 'Ramen',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 100 }, balance: { toNumber: () => -100 },
      },
    ];

    mockPrisma.tagAnalyticsCacheMonthly.findMany.mockResolvedValueOnce(mockRows);

    const req = makeReq({
      method: 'GET',
      query: {
        'tagIds[]': ['5'],
        currency: 'USD',
        view: 'month',
        startMonth: '2026-01',
        endMonth: '2026-03',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.currency).toBe('USD');
    expect(res._body.view).toBe('month');

    // Verify tag 5 structure: tag → time → type → group → categoryName → values
    const tag5 = res._body.tags['5'];
    expect(tag5).toBeDefined();
    expect(tag5['2026-01']['Expense']['Dining']['Sushi']).toEqual({ credit: 0, debit: 450, balance: -450 });
    expect(tag5['2026-01']['Expense']['Transport']['Train']).toEqual({ credit: 0, debit: 200, balance: -200 });
    expect(tag5['2026-02']['Expense']['Dining']['Ramen']).toEqual({ credit: 0, debit: 100, balance: -100 });

    // Verify the Prisma query filters
    expect(mockPrisma.tagAnalyticsCacheMonthly.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        currency: 'USD',
        tenantId: 'test-tenant-123',
        tagId: { in: [5] },
      }),
    });
  });

  it('returns empty tags object when no data exists', async () => {
    mockPrisma.tagAnalyticsCacheMonthly.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      method: 'GET',
      query: { 'tagIds[]': ['5'], startMonth: '2026-01', endMonth: '2026-03' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ currency: 'USD', view: 'month', tags: {} });
  });

  it('supports multiple tagIds for comparison mode', async () => {
    const mockRows = [
      {
        tagId: 5, year: 2026, month: 3, currency: 'USD', country: 'US',
        type: 'Expense', group: 'Dining', categoryId: 10, categoryName: 'Sushi',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 300 }, balance: { toNumber: () => -300 },
      },
      {
        tagId: 12, year: 2026, month: 3, currency: 'USD', country: 'US',
        type: 'Expense', group: 'Transport', categoryId: 20, categoryName: 'Taxi',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 150 }, balance: { toNumber: () => -150 },
      },
    ];

    mockPrisma.tagAnalyticsCacheMonthly.findMany.mockResolvedValueOnce(mockRows);

    const req = makeReq({
      method: 'GET',
      query: {
        'tagIds[]': ['5', '12'],
        startMonth: '2026-03',
        endMonth: '2026-03',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.tags['5']).toBeDefined();
    expect(res._body.tags['12']).toBeDefined();
    expect(res._body.tags['5']['2026-03']['Expense']['Dining']['Sushi'].debit).toBe(300);
    expect(res._body.tags['12']['2026-03']['Expense']['Transport']['Taxi'].debit).toBe(150);

    // Verify both tag IDs are in the query
    expect(mockPrisma.tagAnalyticsCacheMonthly.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tagId: { in: [5, 12] },
      }),
    });
  });

  it('accepts single tagIds param (not array)', async () => {
    mockPrisma.tagAnalyticsCacheMonthly.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      method: 'GET',
      query: { tagIds: '5', startMonth: '2026-01', endMonth: '2026-01' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.tagAnalyticsCacheMonthly.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tagId: { in: [5] },
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Year view
// ---------------------------------------------------------------------------

describe('GET /api/analytics/tags — year view', () => {
  it('returns data keyed by year', async () => {
    const mockRows = [
      {
        tagId: 5, year: 2025, month: 6, currency: 'USD', country: 'US',
        type: 'Expense', group: 'Dining', categoryId: 10, categoryName: 'Sushi',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 200 }, balance: { toNumber: () => -200 },
      },
    ];

    mockPrisma.tagAnalyticsCacheMonthly.findMany.mockResolvedValueOnce(mockRows);

    const req = makeReq({
      method: 'GET',
      query: { 'tagIds[]': ['5'], view: 'year', years: '2025' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.view).toBe('year');
    expect(res._body.tags['5']['2025']['Expense']['Dining']['Sushi'].debit).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Quarter view
// ---------------------------------------------------------------------------

describe('GET /api/analytics/tags — quarter view', () => {
  it('returns data keyed by quarter', async () => {
    const mockRows = [
      {
        tagId: 5, year: 2026, month: 4, currency: 'USD', country: 'JP',
        type: 'Expense', group: 'Lodging', categoryId: 30, categoryName: 'Hotel',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 800 }, balance: { toNumber: () => -800 },
      },
    ];

    mockPrisma.tagAnalyticsCacheMonthly.findMany.mockResolvedValueOnce(mockRows);

    const req = makeReq({
      method: 'GET',
      query: {
        'tagIds[]': ['5'],
        view: 'quarter',
        startQuarter: '2026-Q1',
        endQuarter: '2026-Q2',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.view).toBe('quarter');
    // Month 4 = Q2
    expect(res._body.tags['5']['2026-Q2']['Expense']['Lodging']['Hotel'].debit).toBe(800);
  });
});
