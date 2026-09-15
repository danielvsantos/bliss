/**
 * Integration tests for POST /api/auth/signin
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * All dependencies (Prisma, AuthService, jwt, uuid, rate limiter, cors,
 * cookieUtils) are mocked so we can test the handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

// Mock rate limiter
vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

// Mock cors to no-op
vi.mock('../../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

// Mock cookieUtils
vi.mock('../../../../utils/cookieUtils.js', () => ({
  setAuthCookie: vi.fn(),
}));

// Mock Prisma
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findFirst: vi.fn() },
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

// Mock AuthService.
// The handler calls verifyAndUpgrade, which both verifies against either
// storage format AND transparently rehashes a legacy PBKDF2 row to scrypt.
// The real rehash path is exercised end-to-end against a real database row in
// __tests__/integration/api/auth/password-upgrade.test.ts.
const { mockVerifyAndUpgrade } = vi.hoisted(() => ({
  mockVerifyAndUpgrade: vi.fn(),
}));

vi.mock('../../../../services/auth.service', () => ({
  AuthService: { verifyAndUpgrade: mockVerifyAndUpgrade },
}));

// Mock jsonwebtoken
vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn().mockReturnValue('mock-jwt-token') },
}));

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('test-uuid'),
}));

import handler from '../../../../pages/api/auth/signin.js';
import { setAuthCookie } from '../../../../utils/cookieUtils.js';
import jwt from 'jsonwebtoken';

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
// Test fixture
// ---------------------------------------------------------------------------

const TEST_USER = {
  id: 1,
  email: 'test@example.com',
  name: 'Test User',
  passwordHash: 'hashed-password',
  passwordSalt: 'salt',
  profilePictureUrl: null,
  tenant: { id: 'tenant-1', name: 'Test Tenant' },
};

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /api/auth/signin
// ---------------------------------------------------------------------------

describe('POST /api/auth/signin', () => {
  it('returns 405 for GET request', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });

  it('returns 400 when email is missing', async () => {
    const req = makeReq({ body: { password: 'password123' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Email and password are required' });
  });

  it('returns 400 when password is missing', async () => {
    const req = makeReq({ body: { email: 'test@example.com' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Email and password are required' });
  });

  it('returns 400 for invalid email format', async () => {
    const req = makeReq({ body: { email: 'not-an-email', password: 'password123' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid email format' });
  });

  it('returns 401 for non-existent user', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(null);

    const req = makeReq({ body: { email: 'nobody@example.com', password: 'password123' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Invalid credentials' });
  });

  it('returns 401 for wrong password', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(TEST_USER);
    mockVerifyAndUpgrade.mockResolvedValueOnce(false);

    const req = makeReq({ body: { email: 'test@example.com', password: 'wrong-password' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Invalid credentials' });
    expect(mockVerifyAndUpgrade).toHaveBeenCalledWith(TEST_USER, 'wrong-password');
  });

  it('returns 200 with user object and calls setAuthCookie on success', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(TEST_USER);
    mockVerifyAndUpgrade.mockResolvedValueOnce(true);

    const req = makeReq({ body: { email: 'test@example.com', password: 'correct-password' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      user: {
        id: 1,
        email: 'test@example.com',
        name: 'Test User',
        tenant: { id: 'tenant-1', name: 'Test Tenant' },
        profilePictureUrl: null,
      },
    });

    expect(setAuthCookie).toHaveBeenCalledWith(res, 'mock-jwt-token');
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, tenantId: 'tenant-1', email: 'test@example.com' }),
      expect.any(String),
      expect.objectContaining({ expiresIn: '24h' }),
    );
  });

  // passwordSalt is null for every scrypt-format row. The handler previously
  // required BOTH columns, which would have rejected every user the moment
  // their hash was upgraded — a total lockout with no error to diagnose it.
  it('accepts a scrypt-format user whose passwordSalt is null', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce({
      ...TEST_USER,
      passwordHash: '$scrypt$N=131072,r=8,p=1$c2FsdA==$aGFzaA==',
      passwordSalt: null,
    });
    mockVerifyAndUpgrade.mockResolvedValueOnce(true);

    const req = makeReq({ body: { email: 'test@example.com', password: 'correct-password' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(setAuthCookie).toHaveBeenCalled();
  });

  // A deliberately mixed-case fixture. User.email is deterministically
  // encrypted, so the ciphertext derives from the exact plaintext bytes —
  // without normalization at this call site, a user who types their address
  // with different capitalisation than they registered with simply cannot log
  // in. A suite written entirely in lowercase would never catch it.
  it('normalizes a mixed-case email before looking the user up', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(TEST_USER);
    mockVerifyAndUpgrade.mockResolvedValueOnce(true);

    const req = makeReq({ body: { email: '  TeSt@ExAmPle.COM  ', password: 'correct-password' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'test@example.com' } }),
    );
  });

  // The format regex rejects surrounding whitespace, so normalizing after
  // validating would report a pasted address as malformed.
  it('accepts a padded email rather than rejecting it as malformed', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(TEST_USER);
    mockVerifyAndUpgrade.mockResolvedValueOnce(true);

    const req = makeReq({ body: { email: ' test@example.com ', password: 'correct-password' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });

  it('still rejects a genuinely malformed email', async () => {
    const req = makeReq({ body: { email: 'not an email', password: 'x' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid email format' });
  });

  it('returns 401 for an OAuth-only account with no password hash', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce({
      ...TEST_USER,
      passwordHash: null,
      passwordSalt: null,
    });

    const req = makeReq({ body: { email: 'test@example.com', password: 'anything' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Invalid credentials' });
    expect(mockVerifyAndUpgrade).not.toHaveBeenCalled();
  });
});
