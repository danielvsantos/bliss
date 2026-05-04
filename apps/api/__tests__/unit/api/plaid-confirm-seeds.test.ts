/**
 * Unit tests for POST /api/plaid/transactions/confirm-seeds
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'tenant-abc', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => async (req: any, res: any) => {
    req.user = { ...mockUser };
    return handler(req, res);
  },
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: () => false,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findFirst: vi.fn(), findMany: vi.fn() },
    plaidTransaction: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), count: vi.fn() },
    transaction: { findUnique: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    account: { findMany: vi.fn() },
    category: { findMany: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../utils/produceEvent.js', () => ({ produceEvent: vi.fn().mockResolvedValue(undefined) }));

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import handler from '../../../pages/api/plaid/transactions/confirm-seeds.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'POST', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/plaid/transactions/confirm-seeds', () => {
  it('confirms seeds with empty array and returns 200', async () => {
    mockPrisma.plaidItem.findFirst.mockResolvedValue({ id: 'plaid-item-1', tenantId: 'tenant-abc' });
    mockPrisma.plaidItem.findMany.mockResolvedValue([{ id: 'plaid-item-1' }]);
    mockPrisma.category.findMany.mockResolvedValue([]);
    mockPrisma.account.findMany.mockResolvedValue([]);
    mockPrisma.plaidTransaction.updateMany.mockResolvedValue({ count: 0 });

    const req = makeReq({
      body: {
        plaidItemId: 'plaid-item-1',
        seeds: [],
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });

  it('returns 400 when plaidItemId is missing', async () => {
    const req = makeReq({
      body: { seeds: [{ description: 'Coffee', confirmedCategoryId: 5 }] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 400 when seeds is not an array', async () => {
    const req = makeReq({ body: { plaidItemId: 'plaid-item-1', seeds: 'not-an-array' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/seeds array is required/i);
  });

  it('returns 404 when plaid item not found', async () => {
    mockPrisma.plaidItem.findFirst.mockResolvedValue(null);

    const req = makeReq({
      body: {
        plaidItemId: 'plaid-item-x',
        seeds: [{ description: 'Coffee', confirmedCategoryId: 5 }],
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 405 for GET method', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
