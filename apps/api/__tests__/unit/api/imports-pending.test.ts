/**
 * Unit tests for GET /api/imports/pending
 *
 * Mocked handler pattern: withAuth, cors, rateLimit, Sentry, and Prisma
 * are all mocked so we test handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

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

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stagedImport: {
      findMany: vi.fn(),
    },
    stagedImportRow: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/imports/pending.js';

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

describe('GET /api/imports/pending', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns READY imports with row counts', async () => {
    const now = new Date();
    mockPrisma.stagedImport.findMany.mockResolvedValueOnce([
      { id: 1, fileName: 'test.csv', adapterName: 'Generic', accountId: 10, totalRows: 50, createdAt: now },
      { id: 2, fileName: 'bank.csv', adapterName: 'Chase', accountId: 11, totalRows: 30, createdAt: now },
    ]);
    mockPrisma.stagedImportRow.groupBy.mockResolvedValueOnce([
      { stagedImportId: 2, _count: { _all: 10 } },
      { stagedImportId: 1, _count: { _all: 25 } },
    ]);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.imports).toHaveLength(2);
    expect(res._body.imports[0]).toMatchObject({
      id: 1,
      fileName: 'test.csv',
      pendingRowCount: 25,
    });
    expect(res._body.imports[1]).toMatchObject({
      id: 2,
      fileName: 'bank.csv',
      pendingRowCount: 10,
    });

    // Verify query filters
    expect(mockPrisma.stagedImport.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'test-tenant-123', status: 'READY' },
      orderBy: { createdAt: 'desc' },
    });
    // One grouped count for all imports, not one count per import (#135)
    expect(mockPrisma.stagedImportRow.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stagedImportRow.groupBy).toHaveBeenCalledWith({
      by: ['stagedImportId'],
      where: {
        stagedImportId: { in: [1, 2] },
        status: { in: ['CONFIRMED', 'PENDING', 'POTENTIAL_DUPLICATE'] },
      },
      _count: { _all: true },
    });
  });

  it('filters out imports with zero pending rows', async () => {
    mockPrisma.stagedImport.findMany.mockResolvedValueOnce([
      { id: 1, fileName: 'test.csv', adapterName: 'Generic', accountId: 10, totalRows: 50, createdAt: new Date() },
      { id: 2, fileName: 'empty.csv', adapterName: 'Chase', accountId: 11, totalRows: 30, createdAt: new Date() },
    ]);
    // import 2 has zero pending rows, so groupBy returns no group for it
    mockPrisma.stagedImportRow.groupBy.mockResolvedValueOnce([
      { stagedImportId: 1, _count: { _all: 15 } },
    ]);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.imports).toHaveLength(1);
    expect(res._body.imports[0].id).toBe(1);
  });

  it('returns empty array when no pending imports', async () => {
    mockPrisma.stagedImport.findMany.mockResolvedValueOnce([]);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.imports).toEqual([]);
    expect(mockPrisma.stagedImportRow.groupBy).not.toHaveBeenCalled();
  });
});
