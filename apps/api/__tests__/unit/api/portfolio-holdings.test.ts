/**
 * Unit tests for GET /api/portfolio/holdings
 *
 * Uses the mocked-handler pattern: withAuth, rate limiter, cors, Sentry, and
 * Prisma are all mocked so we test the handler logic in isolation.
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
    portfolioHolding: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/portfolio/holdings.js';

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

describe('GET /api/portfolio/holdings', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns paginated holdings with asset details', async () => {
    mockPrisma.portfolioHolding.count.mockResolvedValueOnce(2);
    mockPrisma.portfolioHolding.findMany.mockResolvedValueOnce([
      {
        id: 1,
        assetId: 10,
        quantity: 100,
        asset: { id: 10, symbol: 'AAPL', category: { name: 'Stocks', group: 'US Equities', type: 'Investments' } },
      },
      {
        id: 2,
        assetId: 11,
        quantity: 50,
        asset: { id: 11, symbol: 'MSFT', category: { name: 'Stocks', group: 'US Equities', type: 'Investments' } },
      },
    ]);

    const req = makeReq({ query: { page: '1', pageSize: '10' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.pagination).toEqual({
      page: 1,
      pageSize: 10,
      totalCount: 2,
      totalPages: 1,
    });
    expect(res._body.data).toHaveLength(2);
    expect(res._body.data[0].asset.symbol).toBe('AAPL');
  });

  it('applies ticker filter', async () => {
    mockPrisma.portfolioHolding.count.mockResolvedValueOnce(1);
    mockPrisma.portfolioHolding.findMany.mockResolvedValueOnce([
      {
        id: 1,
        assetId: 10,
        quantity: 100,
        asset: { id: 10, symbol: 'AAPL', category: { name: 'Stocks', group: 'US Equities', type: 'Investments' } },
      },
    ]);

    const req = makeReq({ query: { ticker: 'AAPL' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.portfolioHolding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          asset: expect.objectContaining({
            symbol: 'AAPL',
          }),
        }),
      }),
    );
  });

  it('applies category filter', async () => {
    mockPrisma.portfolioHolding.count.mockResolvedValueOnce(0);
    mockPrisma.portfolioHolding.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ query: { category: 'Stocks' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.portfolioHolding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          asset: expect.objectContaining({
            category: { name: 'Stocks' },
          }),
        }),
      }),
    );
  });

  it('returns empty array when no holdings', async () => {
    mockPrisma.portfolioHolding.count.mockResolvedValueOnce(0);
    mockPrisma.portfolioHolding.findMany.mockResolvedValueOnce([]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.data).toEqual([]);
    expect(res._body.pagination.totalCount).toBe(0);
  });
});
