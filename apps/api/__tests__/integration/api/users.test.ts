/**
 * Integration tests for POST /api/users (user creation with password)
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * Uses the real bliss_test Postgres database via Prisma.
 *
 * Rate limiter is mocked to a no-op.
 * JWT auth is tested end-to-end: withAuth decodes the token and hydrates req.user
 * from the real bliss_test User table.
 *
 * Requires: bliss_test Postgres database with migrations applied.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Mock rate limiter before any handler imports
vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next()
  ),
}));

import handler from '../../../pages/api/users.js';
import prisma from '../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant } from '../../helpers/tenant.js';
import { AuthService } from '../../../services/auth.service.js';

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

function uniqueEmail(label = '') {
  return `user-test${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.bliss`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /api/users — user creation with password', () => {
  let tenantId: string;
  let adminToken: string;
  let adminUserId: string;

  beforeAll(async () => {
    ({ tenantId, token: adminToken, userId: adminUserId } = await createIsolatedTenant('users'));
  });

  afterAll(async () => {
    await teardownTenant(tenantId);
  });

  it('creates a user with email and password (201)', async () => {
    const email = uniqueEmail('-create');
    const req = makeReq({
      cookies: { token: adminToken },
      body: {
        email,
        password: 'testpass123',
        name: 'Test User',
        role: 'member',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    const body = res._body as { id: number; email: string; name: string; role: string };
    expect(body.email).toBe(email);
    expect(body.name).toBe('Test User');
    expect(body.role).toBe('member');

    // Verify the user can sign in with the password
    const dbUser = await prisma.user.findFirst({
      where: { id: body.id },
      select: { passwordHash: true, passwordSalt: true, provider: true },
    });
    expect(dbUser).not.toBeNull();
    expect(dbUser!.provider).toBe('credentials');
    expect(dbUser!.passwordHash).toBeTruthy();
    expect(dbUser!.passwordSalt).toBeTruthy();

    // Verify password actually matches
    const isValid = await AuthService.verifyPassword('testpass123', dbUser!.passwordHash!, dbUser!.passwordSalt!);
    expect(isValid).toBe(true);
  });

  it('creates a viewer role user (201)', async () => {
    const email = uniqueEmail('-viewer');
    const req = makeReq({
      cookies: { token: adminToken },
      body: {
        email,
        password: 'viewerpass1',
        name: 'Viewer User',
        role: 'viewer',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    const body = res._body as { role: string };
    expect(body.role).toBe('viewer');
  });

  it('defaults role to member when not specified (201)', async () => {
    const email = uniqueEmail('-default');
    const req = makeReq({
      cookies: { token: adminToken },
      body: {
        email,
        password: 'defaultpass1',
        name: 'Default Role',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    const body = res._body as { role: string };
    expect(body.role).toBe('member');
  });

  it('returns 400 when password is missing', async () => {
    const req = makeReq({
      cookies: { token: adminToken },
      body: {
        email: uniqueEmail('-nopw'),
        name: 'No Password',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect((res._body as { error: string }).error).toMatch(/password/i);
  });

  it('returns 400 when password is too short', async () => {
    const req = makeReq({
      cookies: { token: adminToken },
      body: {
        email: uniqueEmail('-shortpw'),
        password: '12345',
        name: 'Short Password',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect((res._body as { error: string }).error).toMatch(/6 characters/i);
  });

  it('returns 400 when email is missing', async () => {
    const req = makeReq({
      cookies: { token: adminToken },
      body: {
        password: 'validpass1',
        name: 'No Email',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect((res._body as { error: string }).error).toMatch(/email/i);
  });

  it('returns 400 for invalid role', async () => {
    const req = makeReq({
      cookies: { token: adminToken },
      body: {
        email: uniqueEmail('-badrole'),
        password: 'validpass1',
        role: 'superadmin',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect((res._body as { error: string }).error).toMatch(/role/i);
  });

  it('returns 409 when email already exists in tenant', async () => {
    const email = uniqueEmail('-dup');

    // First creation
    const req1 = makeReq({
      cookies: { token: adminToken },
      body: { email, password: 'validpass1', name: 'First' },
    });
    const res1 = makeRes();
    await handler(req1 as NextApiRequest, res1 as unknown as NextApiResponse);
    expect(res1._status).toBe(201);

    // Duplicate creation
    const req2 = makeReq({
      cookies: { token: adminToken },
      body: { email, password: 'validpass2', name: 'Duplicate' },
    });
    const res2 = makeRes();
    await handler(req2 as NextApiRequest, res2 as unknown as NextApiResponse);

    expect(res2._status).toBe(409);
    expect((res2._body as { error: string }).error).toMatch(/already exists/i);
  });

  it('returns 401 without authentication', async () => {
    const req = makeReq({
      body: {
        email: uniqueEmail('-noauth'),
        password: 'validpass1',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
  });

  it('returns 403 when non-admin tries to create a user', async () => {
    // Create a member user first
    const memberEmail = uniqueEmail('-member');
    const memberReq = makeReq({
      cookies: { token: adminToken },
      body: { email: memberEmail, password: 'memberpass1', name: 'Member', role: 'member' },
    });
    const memberRes = makeRes();
    await handler(memberReq as NextApiRequest, memberRes as unknown as NextApiResponse);
    expect(memberRes._status).toBe(201);
    const memberId = (memberRes._body as { id: number }).id;

    // Mint a token for the member
    const jwt = await import('jsonwebtoken');
    const memberToken = jwt.default.sign(
      { jti: 'test-jti', userId: memberId, tenantId },
      process.env.JWT_SECRET_CURRENT || 'test-jwt-secret',
      { expiresIn: '1h' }
    );

    // Try to create a user as a member
    const req = makeReq({
      cookies: { token: memberToken },
      body: {
        email: uniqueEmail('-frommember'),
        password: 'validpass1',
        name: 'From Member',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(403);
  });
});
