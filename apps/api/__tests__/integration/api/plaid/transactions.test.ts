/**
 * Integration tests for PUT /api/plaid/transactions/:id
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

// Mock rate limiter
vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

// Inject a test user via withAuth mock
const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

// Mock cors to no-op
vi.mock('../../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

// Mock Sentry
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

// Mock produceEvent
vi.mock('../../../../utils/produceEvent.js', () => ({
  produceEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock Prisma — use vi.hoisted() so the object is available before vi.mock hoisting
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidTransaction: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    category: {
      findFirst: vi.fn(),
    },
    account: {
      findFirst: vi.fn(),
    },
    transaction: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

// Mock global fetch used for fire-and-forget feedback
globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

import handler from '../../../../pages/api/plaid/transactions/[id].js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAID_TX = {
  id: 'plaid-tx-1',
  plaidTransactionId: 'ext-123',
  name: 'Grocery Store',
  merchantName: 'Whole Foods',
  amount: 50.00,
  isoCurrencyCode: 'USD',
  date: '2026-03-01',
  plaidAccountId: 'plaid-acc-1',
  suggestedCategoryId: 5,
  promotionStatus: 'CLASSIFIED',
  classificationSource: 'LLM',
  aiConfidence: 0.85,
  plaidItem: { tenantId: 'test-tenant-123' },
};

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'PUT',
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

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.role = 'admin';
  mockUser.tenantId = 'test-tenant-123';
});

// ---------------------------------------------------------------------------
// PUT /api/plaid/transactions/:id
// ---------------------------------------------------------------------------

describe('PUT /api/plaid/transactions/:id', () => {
  it('returns 405 for GET method', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['PUT']);
  });

  it('returns 404 when PlaidTransaction not found', async () => {
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'PUT', body: { promotionStatus: 'SKIPPED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'PlaidTransaction not found' });
  });

  it('returns 409 when transaction already PROMOTED', async () => {
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce({
      ...PLAID_TX,
      promotionStatus: 'PROMOTED',
    });

    const req = makeReq({ method: 'PUT', body: { promotionStatus: 'SKIPPED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
    expect(res._body).toEqual({ error: 'Transaction already promoted' });
  });

  it('sets SKIPPED status on skip action', async () => {
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce({ ...PLAID_TX });

    const updatedRecord = { ...PLAID_TX, promotionStatus: 'SKIPPED' };
    mockPrisma.plaidTransaction.update.mockResolvedValueOnce(updatedRecord);

    const req = makeReq({ method: 'PUT', body: { promotionStatus: 'SKIPPED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(updatedRecord);
    expect(mockPrisma.plaidTransaction.update).toHaveBeenCalledWith({
      where: { id: 'plaid-tx-1' },
      data: { promotionStatus: 'SKIPPED' },
    });
  });

  it('transitions SKIPPED → CLASSIFIED on re-queue', async () => {
    const skippedTx = { ...PLAID_TX, promotionStatus: 'SKIPPED' };
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce(skippedTx);

    const updatedRecord = { ...PLAID_TX, promotionStatus: 'CLASSIFIED' };
    mockPrisma.plaidTransaction.update.mockResolvedValueOnce(updatedRecord);

    const req = makeReq({ method: 'PUT', body: { promotionStatus: 'CLASSIFIED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(updatedRecord);
    expect(mockPrisma.plaidTransaction.update).toHaveBeenCalledWith({
      where: { id: 'plaid-tx-1' },
      data: { promotionStatus: 'CLASSIFIED' },
    });
  });

  it('returns 400 when promoting without suggestedCategoryId', async () => {
    const noCategoryTx = { ...PLAID_TX, suggestedCategoryId: null };
    mockPrisma.plaidTransaction.findUnique.mockResolvedValueOnce(noCategoryTx);

    const req = makeReq({ method: 'PUT', body: { promotionStatus: 'PROMOTED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({
      error: 'Cannot promote without a category. Please assign a category first.',
    });
  });
});
