/**
 * Unit tests for POST /api/plaid/resync
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma, mockProduceEvent } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: {
      findUnique: vi.fn(),
    },
  },
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

import handler from '../../../pages/api/plaid/resync.js';

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

describe('POST /api/plaid/resync', () => {
  it('returns 405 for non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
  });

  it('emits PLAID_SYNC_UPDATES event for ACTIVE item', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      tenantId: 'test-tenant-123',
      status: 'ACTIVE',
    });

    const req = makeReq({ query: { id: 'item-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ message: 'Sync triggered' });
    expect(mockProduceEvent).toHaveBeenCalledWith({
      type: 'PLAID_SYNC_UPDATES',
      tenantId: 'test-tenant-123',
      plaidItemId: 'item-1',
      source: 'MANUAL_RESYNC',
    });
  });

  it('returns 400 when item is not ACTIVE', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      id: 'item-1',
      tenantId: 'test-tenant-123',
      status: 'LOGIN_REQUIRED',
    });

    const req = makeReq({ query: { id: 'item-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({
      error: 'Cannot sync — item status is LOGIN_REQUIRED. Reconnect first.',
    });
    expect(mockProduceEvent).not.toHaveBeenCalled();
  });

  it('returns 404 when item not found', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ query: { id: 'nonexistent' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Plaid Item not found' });
  });
});
