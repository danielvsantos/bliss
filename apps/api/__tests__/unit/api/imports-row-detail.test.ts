/**
 * Unit tests for PUT /api/imports/[id]/rows/[rowId]
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

vi.mock('../../../utils/cors.js', () => ({
  cors: () => false,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stagedImportRow: { findUnique: vi.fn(), update: vi.fn() },
    category: { findFirst: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import handler from '../../../pages/api/imports/[id]/rows/[rowId].js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'PUT', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
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

const baseRow = {
  id: 'row-1',
  stagedImportId: 'import-1',
  description: 'Coffee',
  status: 'PENDING',
  stagedImport: { id: 'import-1', tenantId: 'tenant-abc', status: 'PROCESSING' },
};

describe('PUT /api/imports/[id]/rows/[rowId]', () => {
  it('updates row status and category', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue(baseRow);
    mockPrisma.category.findFirst.mockResolvedValue({ id: 5, tenantId: 'tenant-abc' });
    mockPrisma.stagedImportRow.update.mockResolvedValue({ ...baseRow, status: 'CONFIRMED', suggestedCategoryId: 5 });

    const req = makeReq({
      query: { id: 'import-1', rowId: 'row-1' },
      body: { status: 'CONFIRMED', suggestedCategoryId: 5 },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });

  it('returns 404 when row not found', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue(null);

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-x' }, body: { status: 'CONFIRMED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 404 when row belongs to different tenant', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue({
      ...baseRow,
      stagedImport: { id: 'import-1', tenantId: 'other-tenant', status: 'PROCESSING' },
    });

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body: { status: 'CONFIRMED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 400 when row does not belong to this import', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue({
      ...baseRow,
      stagedImportId: 'other-import',
    });

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body: { status: 'CONFIRMED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/does not belong/i);
  });

  it('returns 400 when import is COMMITTED', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue({
      ...baseRow,
      stagedImport: { id: 'import-1', tenantId: 'tenant-abc', status: 'COMMITTED' },
    });

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body: { status: 'CONFIRMED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/committed/i);
  });

  it('returns 400 for invalid status override', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue(baseRow);

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body: { status: 'INVALID_STATUS' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 405 for non-PUT methods', async () => {
    const req = makeReq({ method: 'GET', query: { id: 'import-1', rowId: 'row-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
