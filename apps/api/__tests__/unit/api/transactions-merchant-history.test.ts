/**
 * Unit tests for GET /api/transactions/merchant-history
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findMany: vi.fn() },
    plaidTransaction: { findMany: vi.fn() },
    category: { findMany: vi.fn() },
  },
}));

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'tenant-1', role: 'admin', email: 'a@test.com' };

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

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/transactions/merchant-history.js';

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

describe('GET /api/transactions/merchant-history', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns merchant transaction history', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([{ id: 'pi-1' }]);
    mockPrisma.plaidTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'ptx-1',
        date: '2026-03-01',
        merchantName: 'Coffee Shop',
        name: 'COFFEE SHOP',
        amount: 4.5,
        isoCurrencyCode: 'USD',
        suggestedCategoryId: 5,
        matchedTransactionId: 100,
      },
      {
        id: 'ptx-2',
        date: '2026-02-15',
        merchantName: 'Coffee Shop',
        name: 'COFFEE SHOP',
        amount: 3.75,
        isoCurrencyCode: 'USD',
        suggestedCategoryId: 5,
        matchedTransactionId: null,
      },
    ]);
    mockPrisma.category.findMany.mockResolvedValueOnce([
      { id: 5, name: 'Food & Drink', group: 'Lifestyle' },
    ]);

    const req = makeReq({ query: { description: 'Coffee Shop' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(Array.isArray(res._body)).toBe(true);
    expect(res._body).toHaveLength(2);
    expect(res._body[0].description).toBe('Coffee Shop');
    expect(res._body[0].debit).toBe(4.5);
    expect(res._body[0].category).toEqual({ id: 5, name: 'Food & Drink', group: 'Lifestyle' });
    // matchedTransactionId should be used as id when available
    expect(res._body[0].id).toBe(100);
    // Falls back to plaid tx id when matchedTransactionId is null
    expect(res._body[1].id).toBe('ptx-2');
  });

  it('returns 400 without description parameter', async () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing description query parameter' });
  });

  it('returns empty array when tenant has no Plaid items', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ query: { description: 'Coffee' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual([]);
  });
});
