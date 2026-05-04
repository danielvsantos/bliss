/**
 * Unit tests for PUT/DELETE /api/imports/adapters/[id]
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

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    importAdapter: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/imports/adapters/[id].js';

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

describe('PUT /api/imports/adapters/[id]', () => {
  it('updates adapter and returns 200', async () => {
    const adapter = { id: 'adapter-1', tenantId: 'tenant-abc', name: 'Old Name' };
    const updated = { ...adapter, name: 'New Name' };
    mockPrisma.importAdapter.findFirst.mockResolvedValue(adapter);
    mockPrisma.importAdapter.update.mockResolvedValue(updated);

    const req = makeReq({
      method: 'PUT',
      query: { id: 'adapter-1' },
      body: { name: 'New Name' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.name).toBe('New Name');
  });

  it('returns 404 when adapter not found', async () => {
    mockPrisma.importAdapter.findFirst.mockResolvedValue(null);

    const req = makeReq({ method: 'PUT', query: { id: 'x' }, body: { name: 'Y' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });
});

describe('DELETE /api/imports/adapters/[id]', () => {
  it('deletes adapter and returns 200', async () => {
    const adapter = { id: 'adapter-1', tenantId: 'tenant-abc', name: 'Old Name' };
    mockPrisma.importAdapter.findFirst.mockResolvedValue(adapter);
    mockPrisma.importAdapter.delete.mockResolvedValue(adapter);

    const req = makeReq({ method: 'DELETE', query: { id: 'adapter-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });

  it('returns 404 when adapter not found for delete', async () => {
    mockPrisma.importAdapter.findFirst.mockResolvedValue(null);

    const req = makeReq({ method: 'DELETE', query: { id: 'x' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });
});

describe('405 guard', () => {
  it('returns 405 for PATCH', async () => {
    const req = makeReq({ method: 'PATCH', query: { id: 'adapter-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
