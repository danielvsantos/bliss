/**
 * Unit tests for POST /api/plaid/transactions/bulk-requeue
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findMany: vi.fn() },
    plaidTransaction: { updateMany: vi.fn() },
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

import handler from '../../../pages/api/plaid/transactions/bulk-requeue.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
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

describe('POST /api/plaid/transactions/bulk-requeue', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('re-queues SKIPPED transactions back to CLASSIFIED', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([{ id: 'pi-1' }]);
    mockPrisma.plaidTransaction.updateMany.mockResolvedValueOnce({ count: 3 });

    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ updated: 3 });
    expect(mockPrisma.plaidTransaction.updateMany).toHaveBeenCalledWith({
      where: {
        plaidItemId: { in: ['pi-1'] },
        promotionStatus: 'SKIPPED',
      },
      data: {
        promotionStatus: 'CLASSIFIED',
        processed: false,
      },
    });
  });

  it('returns updated:0 when tenant has no Plaid items', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ updated: 0 });
  });

  it('filters by plaidItemId when provided', async () => {
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([
      { id: 'pi-1' },
      { id: 'pi-2' },
    ]);
    mockPrisma.plaidTransaction.updateMany.mockResolvedValueOnce({ count: 1 });

    const req = makeReq({ body: { plaidItemId: 'pi-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ updated: 1 });
    expect(mockPrisma.plaidTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          plaidItemId: { in: ['pi-1'] },
        }),
      }),
    );
  });
});
