/**
 * Unit tests for POST /api/imports/[id]/confirm-seeds
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
    category: { findMany: vi.fn() },
    stagedImportRow: { updateMany: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import handler from '../../../pages/api/imports/[id]/confirm-seeds.js';

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

describe('POST /api/imports/[id]/confirm-seeds', () => {
  it('confirms seeds and returns count', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1' });
    mockPrisma.category.findMany.mockResolvedValue([{ id: 5 }]);
    mockPrisma.stagedImportRow.updateMany.mockResolvedValue({ count: 3 });

    const req = makeReq({
      query: { id: 'import-1' },
      body: { seeds: [{ description: 'Coffee', confirmedCategoryId: 5 }] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.confirmed).toBeGreaterThanOrEqual(0);
  });

  it('returns 400 when seeds is empty', async () => {
    const req = makeReq({ query: { id: 'import-1' }, body: { seeds: [] } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/seeds/i);
  });

  it('returns 400 when seeds is not an array', async () => {
    const req = makeReq({ query: { id: 'import-1' }, body: { seeds: null } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 404 when import not found', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue(null);

    const req = makeReq({
      query: { id: 'import-x' },
      body: { seeds: [{ description: 'Coffee', confirmedCategoryId: 5 }] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 405 for GET', async () => {
    const req = makeReq({ method: 'GET', query: { id: 'import-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
