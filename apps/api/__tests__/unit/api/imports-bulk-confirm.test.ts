/**
 * Unit tests for POST /api/imports/[id]/bulk-confirm
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
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), init: vi.fn() }));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stagedImport: { findFirst: vi.fn() },
    stagedImportRow: { updateMany: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/imports/[id]/bulk-confirm.js';

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

describe('POST /api/imports/[id]/bulk-confirm', () => {
  it('bulk confirms rows and returns count', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1', status: 'PROCESSING' });
    mockPrisma.stagedImportRow.updateMany.mockResolvedValue({ count: 5 });

    const req = makeReq({ query: { id: 'import-1' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.confirmed).toBe(5);
  });

  it('confirms rows filtered by categoryId', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1', status: 'PROCESSING' });
    mockPrisma.stagedImportRow.updateMany.mockResolvedValue({ count: 3 });

    const req = makeReq({ query: { id: 'import-1' }, body: { categoryId: 5 } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.confirmed).toBe(3);
  });

  it('confirms uncategorized rows', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1', status: 'PROCESSING' });
    mockPrisma.stagedImportRow.updateMany.mockResolvedValue({ count: 2 });

    const req = makeReq({ query: { id: 'import-1' }, body: { uncategorized: true } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.confirmed).toBe(2);
  });

  it('returns 404 when import not found', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue(null);

    const req = makeReq({ query: { id: 'import-x' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 400 when import is COMMITTED', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1', status: 'COMMITTED' });

    const req = makeReq({ query: { id: 'import-1' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/committed/i);
  });

  it('returns 400 when import is CANCELLED', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1', status: 'CANCELLED' });

    const req = makeReq({ query: { id: 'import-1' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 400 for invalid categoryId', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1', status: 'PROCESSING' });

    const req = makeReq({ query: { id: 'import-1' }, body: { categoryId: 'invalid' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid categoryid/i);
  });

  it('returns 405 for GET', async () => {
    const req = makeReq({ method: 'GET', query: { id: 'import-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
