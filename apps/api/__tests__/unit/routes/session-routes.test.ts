/**
 * Unit tests for the session-lifecycle routes (#156): refresh,
 * sessions/revoke-others and reauth. The session service is mocked; its
 * behaviour runs against a real DB in
 * __tests__/integration/api/auth/session-lifecycle.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({}, { get: () => (_req: any, _res: any, next: Function) => next() }),
}));
vi.mock('../../../utils/cors.js', () => ({ cors: vi.fn().mockReturnValue(false) }));

const { mockSession, mockPrisma, mockAuth, authState } = vi.hoisted(() => ({
  mockSession: {
    refreshSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
    reauthenticate: vi.fn(),
  },
  mockPrisma: { user: { findFirst: vi.fn() } },
  mockAuth: { verifyPassword: vi.fn() },
  authState: { user: null as any },
}));

vi.mock('../../../services/session.service.js', () => ({ ...mockSession, REAUTH_WINDOW_S: 900 }));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../services/auth.service', () => ({ AuthService: mockAuth }));
vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => (req: any, res: any) => {
    req.user = authState.user;
    return handler(req, res);
  },
}));

import refreshHandler from '../../../pages/api/auth/refresh.js';
import revokeOthersHandler from '../../../pages/api/auth/sessions/revoke-others.js';
import reauthHandler from '../../../pages/api/auth/reauth.js';

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', cookies: {}, headers: { origin: 'http://localhost:8080' }, body: {}, ...overrides } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

const ADMIN = { id: 'u1', tenantId: 't1', email: 'a@b.co', role: 'admin', authenticatedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = ADMIN;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe('POST /api/auth/refresh', () => {
  it('returns 200 when the session service rotates', async () => {
    mockSession.refreshSession.mockResolvedValue({ ok: true });
    const res = makeRes();
    await refreshHandler(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });
  });

  it('passes through the 401 code', async () => {
    mockSession.refreshSession.mockResolvedValue({ ok: false, status: 401, code: 'SESSION_REVOKED' });
    const res = makeRes();
    await refreshHandler(makeReq(), res);
    expect(res._status).toBe(401);
    expect(res._body.code).toBe('SESSION_REVOKED');
  });

  it('refuses GET and foreign origins without calling the service', async () => {
    const get = makeRes();
    await refreshHandler(makeReq({ method: 'GET' }), get);
    expect(get._status).toBe(405);

    const foreign = makeRes();
    await refreshHandler(makeReq({ headers: { origin: 'https://evil.example' } }), foreign);
    expect(foreign._status).toBe(403);
    expect(mockSession.refreshSession).not.toHaveBeenCalled();
  });

  it('returns 500 when the service throws', async () => {
    mockSession.refreshSession.mockRejectedValue(new Error('db'));
    const res = makeRes();
    await refreshHandler(makeReq(), res);
    expect(res._status).toBe(500);
  });
});

describe('POST /api/auth/sessions/revoke-others', () => {
  it('returns the number of revoked sessions', async () => {
    mockSession.revokeOtherSessions.mockResolvedValue({ ok: true, revoked: 2 });
    const res = makeRes();
    await revokeOthersHandler(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ revoked: 2 });
  });

  it('answers 401 without a live session on this device', async () => {
    mockSession.revokeOtherSessions.mockResolvedValue({ ok: false, status: 401, code: 'SESSION_EXPIRED' });
    const res = makeRes();
    await revokeOthersHandler(makeReq(), res);
    expect(res._status).toBe(401);
  });

  it('refuses GET, foreign origins and survives service errors', async () => {
    const get = makeRes();
    await revokeOthersHandler(makeReq({ method: 'GET' }), get);
    expect(get._status).toBe(405);

    const foreign = makeRes();
    await revokeOthersHandler(makeReq({ headers: {} }), foreign);
    expect(foreign._status).toBe(403);
    expect(mockSession.revokeOtherSessions).not.toHaveBeenCalled();

    mockSession.revokeOtherSessions.mockRejectedValue(new Error('db'));
    const err = makeRes();
    await revokeOthersHandler(makeReq(), err);
    expect(err._status).toBe(500);
  });
});

describe('/api/auth/reauth', () => {
  const dbUser = { id: 'u1', tenantId: 't1', email: 'a@b.co', passwordHash: 'h', passwordSalt: null, provider: 'credentials' };

  it('GET reports recent=false and the password method', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(dbUser);
    const res = makeRes();
    await reauthHandler(makeReq({ method: 'GET' }), res);
    expect(res._body).toEqual({ recent: false, methods: ['password'] });
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1', tenantId: 't1' } }));
  });

  it('GET offers Google to a Google-only user when Google is configured', async () => {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    authState.user = { ...ADMIN, authenticatedAt: new Date() };
    mockPrisma.user.findFirst.mockResolvedValue({ ...dbUser, passwordHash: null, provider: 'google' });
    const res = makeRes();
    await reauthHandler(makeReq({ method: 'GET' }), res);
    expect(res._body).toEqual({ recent: true, methods: ['google'] });
  });

  it('POST with the right password re-authenticates', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(dbUser);
    mockAuth.verifyPassword.mockResolvedValue(true);
    const req = makeReq({ body: { password: 'pw' } });
    const res = makeRes();
    await reauthHandler(req, res);
    expect(res._status).toBe(200);
    expect(mockSession.reauthenticate).toHaveBeenCalledWith(req, res, { id: 'u1', tenantId: 't1', email: 'a@b.co' });
  });

  it('POST with a wrong or missing password answers 401 and leaves the session alone', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(dbUser);
    mockAuth.verifyPassword.mockResolvedValue(false);
    for (const body of [{ password: 'wrong' }, {}]) {
      const res = makeRes();
      await reauthHandler(makeReq({ body }), res);
      expect(res._status).toBe(401);
      expect(res._body.code).toBe('REAUTH_FAILED');
    }
    expect(mockSession.reauthenticate).not.toHaveBeenCalled();
  });

  it('POST for a Google-only account answers 400 NO_PASSWORD', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ ...dbUser, passwordHash: null });
    const res = makeRes();
    await reauthHandler(makeReq({ body: { password: 'x' } }), res);
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('NO_PASSWORD');
  });

  it('POST refuses a foreign origin; other methods get 405; a missing user 401; errors 500', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(dbUser);
    const foreign = makeRes();
    await reauthHandler(makeReq({ headers: { origin: 'https://evil.example' }, body: { password: 'pw' } }), foreign);
    expect(foreign._status).toBe(403);
    expect(mockAuth.verifyPassword).not.toHaveBeenCalled();

    const put = makeRes();
    await reauthHandler(makeReq({ method: 'PUT' }), put);
    expect(put._status).toBe(405);

    mockPrisma.user.findFirst.mockResolvedValueOnce(null);
    const missing = makeRes();
    await reauthHandler(makeReq({ method: 'GET' }), missing);
    expect(missing._status).toBe(401);

    mockPrisma.user.findFirst.mockRejectedValueOnce(new Error('db'));
    const err = makeRes();
    await reauthHandler(makeReq({ method: 'GET' }), err);
    expect(err._status).toBe(500);
  });
});
