/**
 * Integration tests for PUT /api/auth/change-password
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * All dependencies (Prisma, AuthService, rate limiter, cors, withAuth)
 * are mocked so we can test the handler logic in isolation.
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

// Mock withAuth to inject req.user
vi.mock('../../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => (req: any, res: any) => {
    req.user = { id: 1, tenantId: 'tenant-1', email: 'test@example.com' };
    return handler(req, res);
  },
}));

// Mock Prisma
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

// Mock AuthService
const { mockVerifyPassword, mockHashPassword } = vi.hoisted(() => ({
  mockVerifyPassword: vi.fn(),
  mockHashPassword: vi.fn(),
}));

vi.mock('../../../../services/auth.service', () => ({
  AuthService: {
    verifyPassword: mockVerifyPassword,
    hashPassword: mockHashPassword,
  },
}));

import handler from '../../../../pages/api/auth/change-password.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'PUT',
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
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_BODY = {
  currentPassword: 'OldPassword1',
  newPassword: 'NewPassword1',
  confirmPassword: 'NewPassword1',
};

const CREDENTIAL_USER = {
  passwordHash: 'hashed-password',
  passwordSalt: 'salt-value',
};

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// PUT /api/auth/change-password
// ---------------------------------------------------------------------------

describe('PUT /api/auth/change-password', () => {
  it('returns 405 for GET request', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });

  it('returns 405 for POST request', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });

  it('returns 400 when currentPassword is missing', async () => {
    const req = makeReq({ body: { newPassword: 'NewPassword1', confirmPassword: 'NewPassword1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'All password fields are required' });
  });

  it('returns 400 when newPassword is missing', async () => {
    const req = makeReq({ body: { currentPassword: 'OldPassword1', confirmPassword: 'NewPassword1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'All password fields are required' });
  });

  it('returns 400 when confirmPassword is missing', async () => {
    const req = makeReq({ body: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'All password fields are required' });
  });

  it('returns 400 when newPassword is shorter than 8 characters', async () => {
    const req = makeReq({ body: { currentPassword: 'OldPassword1', newPassword: 'short', confirmPassword: 'short' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'New password must be at least 8 characters' });
  });

  it('returns 400 when newPassword and confirmPassword do not match', async () => {
    const req = makeReq({ body: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1', confirmPassword: 'Different1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'New password and confirmation do not match' });
  });

  it('returns 400 for OAuth-only user (no passwordHash)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({ passwordHash: null, passwordSalt: null });

    const req = makeReq({ body: VALID_BODY });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Password change is not available for this account' });
  });

  it('returns 401 when current password is incorrect', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(CREDENTIAL_USER);
    mockVerifyPassword.mockResolvedValueOnce(false);

    const req = makeReq({ body: VALID_BODY });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Current password is incorrect' });
    expect(mockVerifyPassword).toHaveBeenCalledWith('OldPassword1', 'hashed-password', 'salt-value');
  });

  it('returns 200 on success and updates password hash', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(CREDENTIAL_USER);
    mockVerifyPassword.mockResolvedValueOnce(true);
    mockHashPassword.mockResolvedValueOnce({ hash: 'new-hash', salt: 'new-salt' });
    mockPrisma.user.update.mockResolvedValueOnce({});

    const req = makeReq({ body: VALID_BODY });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ message: 'Password updated successfully' });

    expect(mockHashPassword).toHaveBeenCalledWith('NewPassword1');
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { passwordHash: 'new-hash', passwordSalt: 'new-salt' },
    });
  });

  it('returns 500 on unexpected error and captures in Sentry', async () => {
    mockPrisma.user.findUnique.mockRejectedValueOnce(new Error('DB connection failed'));

    const req = makeReq({ body: VALID_BODY });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Failed to change password');
  });
});
