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
    importAdapter: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
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
  it('updates adapter name and returns 200', async () => {
    const adapter = { id: 1, tenantId: 'tenant-abc', name: 'Old Name', isActive: true, columnMapping: {} };
    const updated = { ...adapter, name: 'New Name' };
    mockPrisma.importAdapter.findUnique.mockResolvedValue(adapter);
    mockPrisma.importAdapter.update.mockResolvedValue(updated);

    const req = makeReq({
      method: 'PUT',
      query: { id: '1' },
      body: { name: 'New Name' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.adapter.name).toBe('New Name');
  });

  it('returns 400 for invalid adapter ID', async () => {
    const req = makeReq({ method: 'PUT', query: { id: 'not-a-number' }, body: { name: 'Y' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid adapter id/i);
  });

  it('returns 404 when adapter not found', async () => {
    mockPrisma.importAdapter.findUnique.mockResolvedValue(null);

    const req = makeReq({ method: 'PUT', query: { id: '1' }, body: { name: 'Y' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 403 for global adapter (tenantId null)', async () => {
    mockPrisma.importAdapter.findUnique.mockResolvedValue({ id: 1, tenantId: null, isActive: true });

    const req = makeReq({ method: 'PUT', query: { id: '1' }, body: { name: 'Y' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(403);
  });

  it('returns 400 when no update fields provided', async () => {
    mockPrisma.importAdapter.findUnique.mockResolvedValue({ id: 1, tenantId: 'tenant-abc', isActive: true, columnMapping: {} });

    const req = makeReq({ method: 'PUT', query: { id: '1' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/no update fields/i);
  });
});

describe('DELETE /api/imports/adapters/[id]', () => {
  it('soft-deletes adapter and returns 204', async () => {
    const adapter = { id: 1, tenantId: 'tenant-abc', name: 'Old Name', isActive: true };
    mockPrisma.importAdapter.findUnique.mockResolvedValue(adapter);
    mockPrisma.importAdapter.update.mockResolvedValue({ ...adapter, isActive: false });

    const req = makeReq({ method: 'DELETE', query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
  });

  it('returns 404 when adapter not found for delete', async () => {
    mockPrisma.importAdapter.findUnique.mockResolvedValue(null);

    const req = makeReq({ method: 'DELETE', query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });
});

describe('405 guard', () => {
  it('returns 405 for PATCH (after adapter lookup succeeds)', async () => {
    mockPrisma.importAdapter.findUnique.mockResolvedValue({
      id: 1, tenantId: 'tenant-abc', name: 'My Adapter', isActive: true,
    });
    const req = makeReq({ method: 'PATCH', query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
