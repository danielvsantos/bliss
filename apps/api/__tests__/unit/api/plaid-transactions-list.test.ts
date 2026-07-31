/**
 * Unit tests for GET /api/plaid/transactions (index)
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

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findMany: vi.fn() },
    plaidTransaction: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    category: { findMany: vi.fn() },
    account: { findMany: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/plaid/transactions/index.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'GET', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
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

describe('GET /api/plaid/transactions', () => {
  it('returns empty list when tenant has no plaid items', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValue([]);

    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.transactions).toEqual([]);
    expect(res._body.pagination.total).toBe(0);
  });

  it('returns paginated transactions with summary', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValue([{ id: 'pi-1' }]);
    mockPrisma.plaidTransaction.findMany.mockResolvedValue([
      { id: 'pt-1', plaidAccountId: 'pa-1', suggestedCategoryId: 5, plaidItem: { institutionName: 'Chase' } },
    ]);
    mockPrisma.plaidTransaction.count
      .mockResolvedValueOnce(1)   // total count
      .mockResolvedValueOnce(1)   // classified count
      .mockResolvedValueOnce(0)   // pending count
      .mockResolvedValueOnce(0)   // promoted count
      .mockResolvedValueOnce(0)   // skipped count
      .mockResolvedValueOnce(0)   // failed count
      .mockResolvedValueOnce(0);  // seedHeld count
    mockPrisma.plaidTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.category.findMany.mockResolvedValue([{ id: 5, name: 'Food', group: 'Daily', type: 'Essentials' }]);
    mockPrisma.account.findMany.mockResolvedValue([]);

    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.transactions).toHaveLength(1);
    expect(res._body.summary.classified).toBe(1);
  });

  it('includes failed count in summary and supports promotionStatus=FAILED filter', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValue([{ id: 'pi-1' }]);
    mockPrisma.plaidTransaction.findMany.mockResolvedValue([
      { id: 'pt-failed-1', plaidAccountId: 'pa-1', suggestedCategoryId: null, promotionStatus: 'FAILED', plaidItem: { institutionName: 'Chase' } },
    ]);
    mockPrisma.plaidTransaction.count
      .mockResolvedValueOnce(1)   // total count (scoped to promotionStatus=FAILED)
      .mockResolvedValueOnce(0)   // classified count
      .mockResolvedValueOnce(0)   // pending count
      .mockResolvedValueOnce(0)   // promoted count
      .mockResolvedValueOnce(0)   // skipped count
      .mockResolvedValueOnce(3)   // failed count
      .mockResolvedValueOnce(0);  // seedHeld count
    mockPrisma.plaidTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.category.findMany.mockResolvedValue([]);
    mockPrisma.account.findMany.mockResolvedValue([]);

    const req = makeReq({ query: { promotionStatus: 'FAILED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.summary.failed).toBe(3);
    // promotionStatus=FAILED passes through the generic filter branch, scoping the main query
    expect(mockPrisma.plaidTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ promotionStatus: 'FAILED' }) }),
    );
  });

  it('supports promotionStatus filter', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValue([{ id: 'pi-1' }]);
    mockPrisma.plaidTransaction.findMany.mockResolvedValue([]);
    mockPrisma.plaidTransaction.count.mockResolvedValue(0);
    mockPrisma.plaidTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.category.findMany.mockResolvedValue([]);
    mockPrisma.account.findMany.mockResolvedValue([]);

    const req = makeReq({ query: { promotionStatus: 'PROMOTED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });

  it('supports uncategorized filter', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValue([{ id: 'pi-1' }]);
    mockPrisma.plaidTransaction.findMany.mockResolvedValue([]);
    mockPrisma.plaidTransaction.count.mockResolvedValue(0);
    mockPrisma.plaidTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.category.findMany.mockResolvedValue([]);
    mockPrisma.account.findMany.mockResolvedValue([]);

    const req = makeReq({ query: { uncategorized: 'true' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });

  it('returns 405 for POST', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
