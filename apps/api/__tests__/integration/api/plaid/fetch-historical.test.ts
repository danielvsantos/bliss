/**
 * Integration tests for POST /api/plaid/fetch-historical?id=<plaidItemId>
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
const { mockProduceEvent } = vi.hoisted(() => ({
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

// Mock Prisma
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../../pages/api/plaid/fetch-historical.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    headers: {},
    cookies: {},
    body: { fromDate: '2025-01-01' },
    query: { id: 'plaid-item-1' },
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
  mockUser.tenantId = 'test-tenant-123';
});

// ---------------------------------------------------------------------------
// POST /api/plaid/fetch-historical
// ---------------------------------------------------------------------------

describe('POST /api/plaid/fetch-historical', () => {
  it('returns 405 for GET method', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('returns 400 when id query param is missing', async () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing id query parameter' });
  });

  it('returns 400 when fromDate is missing', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing or invalid fromDate (expected YYYY-MM-DD)' });
  });

  it('returns 400 when fromDate format is invalid', async () => {
    const req = makeReq({ body: { fromDate: '01-01-2025' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing or invalid fromDate (expected YYYY-MM-DD)' });
  });

  it('returns 400 when fromDate is more than 2 years ago', async () => {
    const req = makeReq({ body: { fromDate: '2020-01-01' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'fromDate cannot be more than 2 years in the past' });
  });

  it('returns 400 when fromDate is in the future', async () => {
    const req = makeReq({ body: { fromDate: '2099-01-01' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'fromDate cannot be in the future' });
  });

  it('returns 404 when PlaidItem not found', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Plaid Item not found' });
  });

  it('returns 403 when tenant does not match', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'plaid-item-1',
      tenantId: 'other-tenant',
      status: 'ACTIVE',
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'Access denied' });
  });

  it('returns 400 when PlaidItem status is not ACTIVE', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'plaid-item-1',
      tenantId: 'test-tenant-123',
      status: 'REVOKED',
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({
      error: 'Cannot fetch historical data — item status is REVOKED. Reconnect first.',
    });
  });

  it('triggers backfill event for valid request', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'plaid-item-1',
      tenantId: 'test-tenant-123',
      status: 'ACTIVE',
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ message: 'Historical backfill triggered' });
    expect(mockProduceEvent).toHaveBeenCalledWith({
      type: 'PLAID_HISTORICAL_BACKFILL',
      tenantId: 'test-tenant-123',
      plaidItemId: 'plaid-item-1',
      fromDate: '2025-01-01',
    });
  });
});
