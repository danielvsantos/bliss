/**
 * Integration tests for POST /api/plaid/transactions/:id/retry
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * withAuth, rate limiter, cors, Sentry, produceEvent, and Prisma are all
 * mocked so we can test the handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

vi.mock('../../../../utils/cors.js', () => ({
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
vi.mock('../../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidTransaction: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../../pages/api/plaid/transactions/[id]/retry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAILED_PLAID_TX = {
  id: 'plaid-tx-1',
  plaidItemId: 'plaid-item-1',
  promotionStatus: 'FAILED',
  processed: true,
  processingError: 'Gemini classification timed out after 5000ms',
  classificationRetryCount: 1,
  plaidItem: { id: 'plaid-item-1', tenantId: 'test-tenant-123' },
};

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    headers: {},
    cookies: {},
    body: {},
    query: { id: 'plaid-tx-1' },
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
  mockUser.role = 'admin';
  mockUser.tenantId = 'test-tenant-123';
});

describe('POST /api/plaid/transactions/:id/retry', () => {
  it('returns 405 for GET method', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('returns 400 when id is missing', async () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 404 when PlaidTransaction not found', async () => {
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 403 when the transaction belongs to another tenant', async () => {
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce({
      ...FAILED_PLAID_TX,
      plaidItem: { id: 'plaid-item-1', tenantId: 'other-tenant' },
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(403);
  });

  it('returns 409 when the transaction is not FAILED', async () => {
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce({
      ...FAILED_PLAID_TX,
      promotionStatus: 'CLASSIFIED',
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
    expect(mockPrisma.plaidTransaction.update).not.toHaveBeenCalled();
  });

  it('resets the row, enqueues PLAID_TRANSACTION_RETRY, and returns 202', async () => {
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce({ ...FAILED_PLAID_TX });
    const resetRow = {
      ...FAILED_PLAID_TX,
      processed: false,
      promotionStatus: 'PENDING',
      processingError: null,
      classificationRetryCount: 1,
    };
    mockPrisma.plaidTransaction.update.mockResolvedValueOnce(resetRow);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    expect(res._body).toEqual(resetRow);

    // classificationRetryCount is set to 1 (not 0) so a repeat failure goes
    // straight to FAILED again instead of silently re-queuing another retry.
    expect(mockPrisma.plaidTransaction.update).toHaveBeenCalledWith({
      where: { id: 'plaid-tx-1' },
      data: {
        processed: false,
        promotionStatus: 'PENDING',
        processingError: null,
        classificationRetryCount: 1,
      },
    });

    expect(mockProduceEvent).toHaveBeenCalledWith({
      type: 'PLAID_TRANSACTION_RETRY',
      tenantId: 'test-tenant-123',
      plaidItemId: 'plaid-item-1',
    });
  });
});
