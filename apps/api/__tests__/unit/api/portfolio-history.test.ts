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
});
