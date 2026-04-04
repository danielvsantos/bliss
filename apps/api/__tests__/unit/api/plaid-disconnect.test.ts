/**
 * Unit tests for POST /api/plaid/disconnect
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

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

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/plaid/disconnect.js';

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

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/plaid/disconnect', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('sets PlaidItem status to REVOKED', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      tenantId: 'test-tenant-123',
      status: 'ACTIVE',
    });
    mockPrisma.plaidItem.update.mockResolvedValueOnce({});

    const req = makeReq({ query: { id: 'item-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ message: 'Connection disconnected' });
    expect(mockPrisma.plaidItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'REVOKED', updatedAt: expect.any(Date) },
    });
  });

  it('returns 404 when item not found', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ query: { id: 'nonexistent' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Plaid Item not found' });
  });

  it('returns 400 without id query parameter', async () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing id query parameter' });
  });
});
