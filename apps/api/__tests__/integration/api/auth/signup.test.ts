/**
 * Integration tests for POST /api/auth/signup
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * Uses the real bliss_test Postgres database via Prisma.
 *
 * Rate limiter is mocked to a no-op (prevents IP-based test failures).
 * Redis denylist gracefully degrades when REDIS_URL is not set (allowed through).
 *
 * Requires: bliss_test Postgres database with migrations applied.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Mock rate limiter before any handler imports — vi.mock is hoisted automatically
vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next()
  ),
}));

import handler from '../../../../pages/api/auth/signup.js';
import prisma from '../../../../prisma/prisma.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    headers: {},
    cookies: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

interface MockRes extends Partial<NextApiResponse> {
  _status: number | undefined;
  _body: unknown;
  _headers: Record<string, string>;
}

function makeRes(): MockRes {
  const res: MockRes = {
    _status: undefined,
    _body: undefined,
    _headers: {},
    status: vi.fn().mockImplementation((code: number) => {
      res._status = code;
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      res._body = body;
      return res;
    }),
    setHeader: vi.fn().mockImplementation((name: string, value: string) => {
      res._headers[name] = value;
      return res;
    }),
    end: vi.fn(),
  };
  return res;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createdTenantIds: string[] = [];

function uniqueEmail() {
  return `signup-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.bliss`;
}

function validBody(overrides = {}) {
  return {
    email: uniqueEmail(),
    password: 'password123',
    tenantName: `Test Tenant ${Date.now()}`,
    countries: [],
    currencies: [],
    bankIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /api/auth/signup', () => {
  afterAll(async () => {
    // Clean up any tenants created during tests
    for (const tenantId of createdTenantIds) {
      await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
  });

  it('returns 201 and sets Set-Cookie on valid signup', async () => {
    const req = makeReq({ body: validBody() });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    const body = res._body as { user?: { tenantId?: string } };
    expect(body).toMatchObject({ message: 'Signup successful' });
    expect(body.user).toBeDefined();
    expect(res._headers['Set-Cookie']).toContain('token=');

    // Track for cleanup
    if (body.user?.tenantId) createdTenantIds.push(body.user.tenantId);
  });

  it('returns 409 when email is already registered', async () => {
    const email = uniqueEmail();

    // First signup
    const req1 = makeReq({ body: validBody({ email }) });
    const res1 = makeRes();
    await handler(req1 as NextApiRequest, res1 as unknown as NextApiResponse);
    const body1 = res1._body as { user?: { tenantId?: string } };
    if (body1.user?.tenantId) createdTenantIds.push(body1.user.tenantId);

    // Second signup with same email
    const req2 = makeReq({ body: validBody({ email }) });
    const res2 = makeRes();
    await handler(req2 as NextApiRequest, res2 as unknown as NextApiResponse);

    expect(res2._status).toBe(409);
    expect((res2._body as { error: string }).error).toMatch(/already exists/i);
  });

  it('returns 400 when tenantName is missing', async () => {
    const req = makeReq({ body: { ...validBody(), tenantName: undefined } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 400 when password is shorter than 8 characters', async () => {
    const req = makeReq({ body: validBody({ password: 'short' }) });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect((res._body as { error: string }).error).toMatch(/8 characters/i);
  });

  it('returns 405 for non-POST requests', async () => {
    const req = makeReq({ method: 'GET', body: validBody() });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
