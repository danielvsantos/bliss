/**
 * Unit tests for POST /api/auth/signup — branch coverage for validation paths
 * not easily covered by integration tests (which need a real DB)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), init: vi.fn() }));
vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn().mockReturnValue('mock-jwt') },
  sign: vi.fn().mockReturnValue('mock-jwt'),
}));
vi.mock('uuid', () => ({ v4: vi.fn().mockReturnValue('test-uuid') }));
vi.mock('../../../utils/cookieUtils.js', () => ({ setAuthCookie: vi.fn() }));
vi.mock('../../../lib/defaultCategories.js', () => ({
  DEFAULT_CATEGORIES: [
    { code: 'FOOD', name: 'Food', group: 'Daily', type: 'Essentials' },
  ],
}));

const { mockPrisma, mockAuthService } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    country: { findMany: vi.fn() },
    currency: { findMany: vi.fn() },
    bank: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockAuthService: {
    hashPassword: vi.fn().mockResolvedValue({ hash: 'hashed', salt: 'salt' }),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../services/auth.service', () => ({ AuthService: mockAuthService }));
vi.mock('../../../services/auth.service.js', () => ({ AuthService: mockAuthService }));

import handler from '../../../pages/api/auth/signup.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'POST', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn((msg?: string) => { res._ended = msg; return res; });
  res.setHeader = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET_CURRENT = 'test-jwt-secret';
});

describe('POST /api/auth/signup validation', () => {
  it('returns 400 when required fields missing', async () => {
    const req = makeReq({ body: { email: 'test@test.com' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/email, password, and tenantName are required/i);
  });

  it('returns 400 when password too short', async () => {
    const req = makeReq({ body: { email: 'test@test.com', password: '123', tenantName: 'My Tenant' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/at least 8 characters/i);
  });

  it('returns 400 for invalid email format', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const req = makeReq({ body: { email: 'not-an-email', password: 'password123', tenantName: 'My Tenant' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid email format/i);
  });

  it('returns 409 when email already exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing' });

    const req = makeReq({ body: { email: 'test@test.com', password: 'password123', tenantName: 'My Tenant' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
  });

  it('returns 405 for GET', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });

  it('returns 400 when invalid country/currency codes provided', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.country.findMany.mockResolvedValue([]); // no valid countries
    mockPrisma.currency.findMany.mockResolvedValue([]); // no valid currencies

    const req = makeReq({
      body: {
        email: 'test@test.com',
        password: 'password123',
        tenantName: 'My Tenant',
        countries: ['XX'],
        currencies: ['ZZZ'],
        bankIds: [],
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/invalid country or currency codes/i);
  });
});
