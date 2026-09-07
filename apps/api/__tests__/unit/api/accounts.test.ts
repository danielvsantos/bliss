/**
 * Unit tests for /api/accounts — covering branches not hit by integration tests
 * POST (create), PUT (update), DELETE, 405 guard
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
    account: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    tenantCurrency: { findFirst: vi.fn() },
    tenantCountry: { findFirst: vi.fn() },
    tenantBank: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    accountOwner: { deleteMany: vi.fn(), createMany: vi.fn() },
    transaction: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/accounts.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'GET', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
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

describe('GET /api/accounts', () => {
  it('returns paginated accounts list', async () => {
    mockPrisma.account.findMany.mockResolvedValue([]);
    mockPrisma.account.count.mockResolvedValue(0);

    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.accounts).toEqual([]);
  });

  it('returns single account when id provided', async () => {
    const account = { id: 1, tenantId: 'tenant-abc', name: 'Checking' };
    mockPrisma.account.findUnique.mockResolvedValue(account);

    const req = makeReq({ query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.name).toBe('Checking');
  });

  it('returns 404 when account not found by id', async () => {
    mockPrisma.account.findUnique.mockResolvedValue(null);

    const req = makeReq({ query: { id: '99' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 404 when account belongs to different tenant', async () => {
    mockPrisma.account.findUnique.mockResolvedValue({ id: 1, tenantId: 'other-tenant', name: 'Checking' });

    const req = makeReq({ query: { id: '1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });
});

describe('POST /api/accounts', () => {
  it('returns 400 when required fields missing', async () => {
    const req = makeReq({ method: 'POST', body: { name: 'Savings' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/missing required fields/i);
  });

  it('returns 400 for invalid bankId', async () => {
    const req = makeReq({
      method: 'POST',
      body: { name: 'S', accountNumber: '123', bankId: 'not-a-number', currencyCode: 'USD', countryId: 'US', ownerIds: [1] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid bankId/i);
  });

  it('returns 400 when currency/country/bank not available for tenant', async () => {
    mockPrisma.tenantCurrency.findFirst.mockResolvedValue(null);
    mockPrisma.tenantCountry.findFirst.mockResolvedValue(null);
    mockPrisma.tenantBank.findUnique.mockResolvedValue(null);

    const req = makeReq({
      method: 'POST',
      body: { name: 'S', accountNumber: '123', bankId: 1, currencyCode: 'USD', countryId: 'US', ownerIds: [1] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid input/i);
  });

  it('returns 400 when owner ids are invalid', async () => {
    mockPrisma.tenantCurrency.findFirst.mockResolvedValue({ id: 'USD' });
    mockPrisma.tenantCountry.findFirst.mockResolvedValue({ id: 'US' });
    mockPrisma.tenantBank.findUnique.mockResolvedValue({ bankId: 1 });
    mockPrisma.user.findMany.mockResolvedValue([]); // no valid users

    const req = makeReq({
      method: 'POST',
      body: { name: 'S', accountNumber: '123', bankId: 1, currencyCode: 'USD', countryId: 'US', ownerIds: [999] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid owner/i);
  });

  it('creates account successfully', async () => {
    mockPrisma.tenantCurrency.findFirst.mockResolvedValue({ id: 'USD' });
    mockPrisma.tenantCountry.findFirst.mockResolvedValue({ id: 'US' });
    mockPrisma.tenantBank.findUnique.mockResolvedValue({ bankId: 1 });
    mockPrisma.user.findMany.mockResolvedValue([{ id: 1 }]);
    const created = { id: 10, name: 'Savings', tenantId: 'tenant-abc' };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.account.create.mockResolvedValue(created);
      return fn(mockPrisma);
    });

    const req = makeReq({
      method: 'POST',
      body: { name: 'Savings', accountNumber: '123', bankId: 1, currencyCode: 'USD', countryId: 'US', ownerIds: [1] },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
  });
});

describe('PUT /api/accounts', () => {
  it('returns 400 when id missing', async () => {
    const req = makeReq({ method: 'PUT', query: {}, body: { name: 'New' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/id must be provided/i);
  });

  it('returns 400 for invalid id format', async () => {
    const req = makeReq({ method: 'PUT', query: { id: 'abc' }, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid account id format/i);
  });

  it('returns 404 when account not found', async () => {
    mockPrisma.account.findUnique.mockResolvedValue(null);

    const req = makeReq({ method: 'PUT', query: { id: '99' }, body: { name: 'New' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });
});

describe('DELETE /api/accounts', () => {
  it('returns 400 when id missing', async () => {
    const req = makeReq({ method: 'DELETE', query: {}, body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 404 when account not found', async () => {
    mockPrisma.account.findUnique.mockResolvedValue(null);

    const req = makeReq({ method: 'DELETE', query: { id: '99' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });
});

describe('405 guard', () => {
  it('returns 405 for PATCH', async () => {
    const req = makeReq({ method: 'PATCH' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
