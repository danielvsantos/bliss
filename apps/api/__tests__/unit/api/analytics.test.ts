/**
 * Unit tests for /api/analytics
 *
 * Mocked handler pattern: withAuth, cors, rateLimit, Sentry, and Prisma
 * are all mocked so we test handler logic in isolation.
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
    analyticsCacheMonthly: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/analytics.js';

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

describe('Method validation', () => {
  it('returns 405 for unsupported methods (PATCH)', async () => {
    const req = makeReq({ method: 'PATCH' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
  });
});

describe('GET /api/analytics — year view', () => {
  it('returns analytics data with year view', async () => {
    const mockRows = [
      {
        year: 2025, month: 6, currency: 'USD', country: 'US',
        type: 'Expense', group: 'Dining',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 300 }, balance: { toNumber: () => -300 },
      },
      {
        year: 2025, month: 8, currency: 'USD', country: 'US',
        type: 'Expense', group: 'Transport',
        credit: { toNumber: () => 0 }, debit: { toNumber: () => 150 }, balance: { toNumber: () => -150 },
      },
    ];

    mockPrisma.analyticsCacheMonthly.findMany.mockResolvedValueOnce(mockRows);

    const req = makeReq({
      method: 'GET',
      query: { view: 'year', years: '2025', currency: 'USD' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.currency).toBe('USD');
    expect(res._body.view).toBe('year');
    // Both rows are year 2025, so they aggregate under the same key
    expect(res._body.data['2025']['Expense']['Dining']).toEqual({ credit: 0, debit: 300, balance: -300 });
    expect(res._body.data['2025']['Expense']['Transport']).toEqual({ credit: 0, debit: 150, balance: -150 });
  });

  it('applies currency filter', async () => {
    mockPrisma.analyticsCacheMonthly.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      method: 'GET',
      query: { view: 'year', years: '2025', currency: 'EUR' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.currency).toBe('EUR');
    expect(mockPrisma.analyticsCacheMonthly.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        currency: 'EUR',
        tenantId: 'test-tenant-123',
      }),
    });
  });

  it('returns empty object when no data', async () => {
    mockPrisma.analyticsCacheMonthly.findMany.mockResolvedValueOnce([]);

    const req = makeReq({
      method: 'GET',
      query: { view: 'year', years: '2025' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.data).toEqual({});
  });
});
