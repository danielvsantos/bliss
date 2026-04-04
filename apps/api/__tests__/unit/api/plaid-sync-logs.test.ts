/**
 * Unit tests for GET /api/plaid/sync-logs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findUnique: vi.fn() },
    plaidSyncLog: { findMany: vi.fn() },
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

import handler from '../../../pages/api/plaid/sync-logs.js';

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

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/plaid/sync-logs', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns sync logs with default limit', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      tenantId: 'test-tenant-123',
    });

    const mockLogs = [
      { id: 'log-1', plaidItemId: 'item-1', createdAt: new Date(), status: 'SUCCESS' },
      { id: 'log-2', plaidItemId: 'item-1', createdAt: new Date(), status: 'SUCCESS' },
    ];
    mockPrisma.plaidSyncLog.findMany.mockResolvedValueOnce(mockLogs);

    const req = makeReq({ query: { plaidItemId: 'item-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(mockLogs);
    expect(mockPrisma.plaidSyncLog.findMany).toHaveBeenCalledWith({
      where: { plaidItemId: 'item-1' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  });

  it('respects custom limit parameter (max 100)', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      tenantId: 'test-tenant-123',
    });
    mockPrisma.plaidSyncLog.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ query: { plaidItemId: 'item-1', limit: '50' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.plaidSyncLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );

    // Verify max cap of 100
    vi.clearAllMocks();
    mockPrisma.plaidItem.findUnique.mockResolvedValueOnce({
      tenantId: 'test-tenant-123',
    });
    mockPrisma.plaidSyncLog.findMany.mockResolvedValueOnce([]);

    const req2 = makeReq({ query: { plaidItemId: 'item-1', limit: '999' } });
    const res2 = makeRes();

    await handler(req2 as NextApiRequest, res2 as unknown as NextApiResponse);

    expect(mockPrisma.plaidSyncLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });

  it('returns 400 without plaidItemId', async () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Missing plaidItemId query parameter' });
  });
});
