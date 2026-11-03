/**
 * Unit tests for GET /api/auth/google-token
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), init: vi.fn() }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn().mockReturnValue('mock-jwt-token') },
  sign: vi.fn().mockReturnValue('mock-jwt-token'),
}));
vi.mock('uuid', () => ({ v4: vi.fn().mockReturnValue('test-uuid') }));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    userSession: { findFirst: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
const { mockSession } = vi.hoisted(() => ({
  mockSession: { findLiveSession: vi.fn(), reauthenticate: vi.fn() },
}));
vi.mock('../../../services/session.service.js', () => mockSession);

import { getToken } from 'next-auth/jwt';
const mockGetToken = getToken as ReturnType<typeof vi.fn>;

import handler from '../../../pages/api/auth/google-token.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'GET', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res._status = undefined;
  res._redirectUrl = undefined;
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn((msg?: string) => { res._ended = msg; return res; });
  res.setHeader = vi.fn((name: string, value: unknown) => { res._headers[name.toLowerCase()] = value; return res; });
  res.getHeader = vi.fn((name: string) => res._headers[name.toLowerCase()]);
  res._headers = {} as Record<string, unknown>;
  res.redirect = vi.fn((url: string) => { res._redirectUrl = url; return res; });
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET_CURRENT = 'test-jwt-secret';
  process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
  process.env.FRONTEND_URL = 'http://localhost:8080';
  mockPrisma.userSession.findFirst.mockResolvedValue(null);
});

/** A NextAuth token minted by a Google sign-in `agoMs` ago (#78 R2). */
const fresh = (extra: Record<string, unknown> = {}, agoMs = 5_000) => ({ signedInAt: Date.now() - agoMs, ...extra });

describe('GET /api/auth/google-token', () => {
  it('exchanges token and redirects to frontend callback', async () => {
    mockGetToken.mockResolvedValue(fresh({ id: 1, email: 'user@test.com', isNew: false }));
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      email: 'user@test.com',
      tenantId: 'tenant-abc',
      name: 'Test User',
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._redirectUrl).toMatch(/\/auth\/callback/);
  });

  it('redirects with isNew=true for new users', async () => {
    mockGetToken.mockResolvedValue(fresh({ id: 1, email: 'new@test.com', isNew: true }));
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 1,
      email: 'new@test.com',
      tenantId: 'tenant-abc',
      name: 'New User',
    });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._redirectUrl).toMatch(/isNew=true/);
  });

  it('starts or steps up the session through reauthenticate (#156)', async () => {
    const live = { id: 'sess', userId: 1, tenantId: 'tenant-abc' };
    mockSession.findLiveSession.mockResolvedValue(live);
    mockGetToken.mockResolvedValue(fresh({ id: 1, email: 'user@test.com', isNew: false }));
    const user = { id: 1, email: 'user@test.com', tenantId: 'tenant-abc', name: 'Test User' };
    mockPrisma.user.findUnique.mockResolvedValue({ ...user, sessionsRevokedAt: null });

    const req = makeReq();
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(mockSession.reauthenticate).toHaveBeenCalledWith(req, res, user, { session: live });
    expect(res._redirectUrl).toMatch(/\/auth\/callback/);
  });

  it('redirects with oauth_failed when the session cannot be issued', async () => {
    mockGetToken.mockResolvedValue(fresh({ id: 1, email: 'user@test.com' }));
    mockPrisma.user.findUnique.mockResolvedValue({ id: 1, email: 'user@test.com', tenantId: 't' });
    mockSession.findLiveSession.mockResolvedValue(null);
    mockSession.reauthenticate.mockRejectedValueOnce(new Error('db down'));

    const res = makeRes();
    await handler(makeReq() as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._redirectUrl).toMatch(/error=oauth_failed/);
  });

  it('redirects with error when nextAuthToken is missing', async () => {
    mockGetToken.mockResolvedValue(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._redirectUrl).toMatch(/error=oauth_failed/);
  });

  it('redirects with error when user not found in DB', async () => {
    mockGetToken.mockResolvedValue({ id: 99, email: 'ghost@test.com' });
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._redirectUrl).toMatch(/error=oauth_failed/);
  });

  it('returns 405 for POST', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });

  // ─── #78 R2: the NextAuth cookie is single-use glue ───────────────────────
  describe('single-use NextAuth cookie (#78 R2)', () => {
    const user = { id: 1, email: 'user@test.com', tenantId: 'tenant-abc', name: 'Test User', sessionsRevokedAt: null };

    function setCookies(res: any): string[] {
      const v = res._headers['set-cookie'];
      return Array.isArray(v) ? v : v ? [String(v)] : [];
    }

    async function run() {
      const res = makeRes();
      await handler(makeReq() as NextApiRequest, res as unknown as NextApiResponse);
      return res;
    }

    it('clears both NextAuth cookie names on success', async () => {
      mockGetToken.mockResolvedValue(fresh({ id: 1 }));
      mockPrisma.user.findUnique.mockResolvedValue(user);

      const res = await run();

      expect(res._redirectUrl).toMatch(/\/auth\/callback/);
      const cookies = setCookies(res);
      expect(cookies.some((c) => /^next-auth\.session-token=;.*Max-Age=0/.test(c))).toBe(true);
      expect(cookies.some((c) => /^__Secure-next-auth\.session-token=;.*Max-Age=0.*Secure/.test(c))).toBe(true);
    });

    it('refuses a token whose Google sign-in is older than 5 minutes (no step-up bypass)', async () => {
      mockGetToken.mockResolvedValue(fresh({ id: 1 }, 301_000));
      mockPrisma.user.findUnique.mockResolvedValue(user);

      const res = await run();

      expect(res._redirectUrl).toMatch(/error=oauth_failed/);
      expect(mockSession.reauthenticate).not.toHaveBeenCalled();
      expect(setCookies(res).some((c) => c.startsWith('next-auth.session-token=;'))).toBe(true);
    });

    it('refuses a token without signedInAt (issued before this change, or iat-only)', async () => {
      mockGetToken.mockResolvedValue({ id: 1, iat: Math.floor(Date.now() / 1000) });
      mockPrisma.user.findUnique.mockResolvedValue(user);

      const res = await run();

      expect(res._redirectUrl).toMatch(/error=oauth_failed/);
      expect(mockSession.reauthenticate).not.toHaveBeenCalled();
    });

    it('refuses a token issued before a password change / sign out of other devices', async () => {
      mockGetToken.mockResolvedValue(fresh({ id: 1 }, 60_000));
      mockPrisma.user.findUnique.mockResolvedValue({ ...user, sessionsRevokedAt: new Date(Date.now() - 30_000) });

      const res = await run();

      expect(res._redirectUrl).toMatch(/error=oauth_failed/);
      expect(mockSession.reauthenticate).not.toHaveBeenCalled();
    });

    it('refuses a replay: a session of this user was authenticated at or after the token', async () => {
      mockGetToken.mockResolvedValue(fresh({ id: 1 }, 60_000));
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.userSession.findFirst.mockResolvedValue({ authenticatedAt: new Date(Date.now() - 50_000) });

      const res = await run();

      expect(res._redirectUrl).toMatch(/error=oauth_failed/);
      expect(mockSession.reauthenticate).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId: 'tenant-abc', userId: 1 },
        orderBy: { authenticatedAt: 'desc' },
      }));
    });

    it('accepts a token newer than the last session authentication', async () => {
      mockGetToken.mockResolvedValue(fresh({ id: 1 }, 10_000));
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.userSession.findFirst.mockResolvedValue({ authenticatedAt: new Date(Date.now() - 3_600_000) });

      const res = await run();

      expect(res._redirectUrl).toMatch(/\/auth\/callback/);
      expect(mockSession.reauthenticate).toHaveBeenCalledTimes(1);
      // sessionsRevokedAt is never passed into the session/JWT
      expect(mockSession.reauthenticate.mock.calls[0][2]).not.toHaveProperty('sessionsRevokedAt');
    });
  });
});
