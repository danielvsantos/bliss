/**
 * Integration tests for GET/PUT /api/tenants/settings
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * withAuth, rate limiter, cors, Sentry, and Prisma are all mocked so we can
 * test the handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

// Mock rate limiter
vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next()
  ),
}));

// Inject a test user via withAuth mock — role can be overridden per test via
// the shared `mockUser` object.
const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
}));

// Mock cors to no-op
vi.mock('../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

// Mock Sentry
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

// Mock Prisma — use vi.hoisted() so the object is available before vi.mock hoisting
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenant: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    tenantCurrency: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/tenants/settings.js';

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
  // Reset to admin role (tests can override)
  mockUser.role = 'admin';
});

// ---------------------------------------------------------------------------
// GET /api/tenants/settings
// ---------------------------------------------------------------------------

describe('GET /api/tenants/settings', () => {
  it('returns autoPromoteThreshold, reviewThreshold, and portfolioCurrency', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({
      autoPromoteThreshold: 0.90,
      reviewThreshold: 0.7,
      portfolioCurrency: 'USD',
    });

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      autoPromoteThreshold: 0.90,
      reviewThreshold: 0.7,
      portfolioCurrency: 'USD',
    });

    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 'test-tenant-123' },
      select: { autoPromoteThreshold: true, reviewThreshold: true, portfolioCurrency: true, plaidHistoryDays: true },
    });
  });

  it('returns 404 when tenant is not found', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Tenant not found' });
  });
});

// ---------------------------------------------------------------------------
// PUT /api/tenants/settings
// ---------------------------------------------------------------------------

describe('PUT /api/tenants/settings', () => {
  it('updates portfolioCurrency when valid', async () => {
    mockPrisma.tenantCurrency.findMany.mockResolvedValueOnce([
      { currencyId: 'USD' },
      { currencyId: 'EUR' },
      { currencyId: 'BRL' },
    ]);

    const updatedTenant = {
      autoPromoteThreshold: 0.90,
      reviewThreshold: 0.7,
      portfolioCurrency: 'EUR',
    };
    mockPrisma.tenant.update.mockResolvedValueOnce(updatedTenant);

    const req = makeReq({
      method: 'PUT',
      body: { portfolioCurrency: 'EUR' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(updatedTenant);

    expect(mockPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 'test-tenant-123' },
      data: { portfolioCurrency: 'EUR' },
      select: { autoPromoteThreshold: true, reviewThreshold: true, portfolioCurrency: true, plaidHistoryDays: true },
    });
  });

  it('rejects portfolioCurrency not in tenant currency list', async () => {
    mockPrisma.tenantCurrency.findMany.mockResolvedValueOnce([
      { currencyId: 'USD' },
      { currencyId: 'EUR' },
    ]);

    const req = makeReq({
      method: 'PUT',
      body: { portfolioCurrency: 'JPY' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('portfolioCurrency must be one of');
    expect(res._body.error).toContain('USD');
    expect(res._body.error).toContain('EUR');

    // Should NOT have called tenant.update
    expect(mockPrisma.tenant.update).not.toHaveBeenCalled();
  });

  it('returns updated settings after successful threshold update', async () => {
    const updatedTenant = {
      autoPromoteThreshold: 0.85,
      reviewThreshold: 0.6,
      portfolioCurrency: 'USD',
    };
    mockPrisma.tenant.update.mockResolvedValueOnce(updatedTenant);

    const req = makeReq({
      method: 'PUT',
      body: { autoPromoteThreshold: 0.85, reviewThreshold: 0.6 },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(updatedTenant);

    expect(mockPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 'test-tenant-123' },
      data: { autoPromoteThreshold: 0.85, reviewThreshold: 0.6 },
      select: { autoPromoteThreshold: true, reviewThreshold: true, portfolioCurrency: true, plaidHistoryDays: true },
    });
  });

  it('returns 403 when user is not admin', async () => {
    mockUser.role = 'member';

    const req = makeReq({
      method: 'PUT',
      body: { portfolioCurrency: 'EUR' },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'Admin access required' });

    // Should NOT have touched the database
    expect(mockPrisma.tenant.update).not.toHaveBeenCalled();
    expect(mockPrisma.tenantCurrency.findMany).not.toHaveBeenCalled();
  });

  it('returns 400 when no update fields are provided', async () => {
    const req = makeReq({
      method: 'PUT',
      body: {},
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Provide at least one of');
  });
});

// ---------------------------------------------------------------------------
// Method not allowed
// ---------------------------------------------------------------------------

describe('Unsupported methods on /api/tenants/settings', () => {
  it('returns 405 for DELETE', async () => {
    const req = makeReq({ method: 'DELETE' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
