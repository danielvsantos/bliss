/**
 * Unit tests for POST /api/plaid/rotate-token
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
vi.mock('../../../utils/cors', () => ({ cors: () => false }));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), init: vi.fn() }));

const mockPlaidClient = { itemAccessTokenInvalidate: vi.fn() };
vi.mock('../../../services/plaid.service', () => ({ plaidClient: mockPlaidClient }));
vi.mock('../../../services/plaid.service.js', () => ({ plaidClient: mockPlaidClient }));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma', () => ({ default: mockPrisma }));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/plaid/rotate-token.js';

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

describe('POST /api/plaid/rotate-token', () => {
  it('rotates token and returns 200', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue({
      id: 'pi-1',
      accessToken: 'old-token',
      tenantId: 'tenant-abc',
      itemId: 'ext-item-1',
    });
    mockPlaidClient.itemAccessTokenInvalidate.mockResolvedValue({
      data: { new_access_token: 'new-token' },
    });
    mockPrisma.plaidItem.update.mockResolvedValue({ id: 'pi-1' });

    const req = makeReq({ query: { id: 'pi-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.message).toMatch(/rotated/i);
  });

  it('returns 400 when id is missing', async () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/missing id/i);
  });

  it('returns 404 when item not found', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue(null);

    const req = makeReq({ query: { id: 'pi-x' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 403 when item belongs to different tenant', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue({
      id: 'pi-1',
      accessToken: 'old-token',
      tenantId: 'other-tenant',
      itemId: 'ext-item-1',
    });

    const req = makeReq({ query: { id: 'pi-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(403);
    expect(res._body.error).toMatch(/access denied/i);
  });

  it('returns 500 on Plaid error', async () => {
    mockPrisma.plaidItem.findUnique.mockResolvedValue({
      id: 'pi-1',
      accessToken: 'old-token',
      tenantId: 'tenant-abc',
      itemId: 'ext-item-1',
    });
    mockPlaidClient.itemAccessTokenInvalidate.mockRejectedValue(new Error('Plaid down'));

    const req = makeReq({ query: { id: 'pi-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
  });

  it('returns 405 for GET', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
