import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusCodes } from 'http-status-codes';

// Mock all external dependencies before importing the module under test
vi.mock('jsonwebtoken', () => ({
  default: { verify: vi.fn() },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    apiKey: { findUnique: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock('../../../utils/denylist.js', () => ({
  isRevoked: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: vi.fn().mockReturnValue(false), // false = not OPTIONS, continue to auth
}));

import jwt from 'jsonwebtoken';
import prisma from '../../../prisma/prisma.js';
import { isRevoked } from '../../../utils/denylist.js';
import { cors } from '../../../utils/cors.js';
import { withAuth } from '../../../utils/withAuth.js';
import { generateApiKey, _resetLastUsedThrottle } from '../../../utils/apiKeys.js';

const mockJwt = vi.mocked(jwt);
const mockPrisma = vi.mocked(prisma);
const mockIsRevoked = vi.mocked(isRevoked);
const mockCors = vi.mocked(cors);

const TEST_USER = { id: 1, tenantId: 'tenant-1', email: 'test@example.com', role: 'USER' };
const VIEWER_USER = { id: 2, tenantId: 'tenant-1', email: 'viewer@example.com', role: 'viewer' };
const VALID_TOKEN = 'valid.jwt.token';

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    cookies: {},
    headers: {},
    ...overrides,
  } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET_CURRENT = 'test-jwt-secret';
  // By default: valid token, user exists, not revoked
  (mockJwt.verify as ReturnType<typeof vi.fn>).mockReturnValue({ userId: 1, jti: 'jti-1' });
  (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(TEST_USER);
  mockIsRevoked.mockResolvedValue(false);
  mockCors.mockReturnValue(false);
});

describe('withAuth()', () => {
  it('attaches req.user and calls handler on valid cookie token', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const req = makeReq({ cookies: { token: VALID_TOKEN } });
    const res = makeRes();

    await withAuth(handler)(req, res);

    expect(handler).toHaveBeenCalledOnce();
    expect(req.user).toEqual(TEST_USER);
  });

  it('attaches req.user from Bearer Authorization header as fallback', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const req = makeReq({ headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    const res = makeRes();

    await withAuth(handler)(req, res);

    expect(handler).toHaveBeenCalledOnce();
    expect(req.user).toEqual(TEST_USER);
  });

  it('returns 401 when no token is present', async () => {
    const handler = vi.fn();
    const req = makeReq();
    const res = makeRes();

    await withAuth(handler)(req, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when token verification fails (invalid/expired)', async () => {
    (mockJwt.verify as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('invalid'); });
    const handler = vi.fn();
    const req = makeReq({ cookies: { token: 'bad-token' } });
    const res = makeRes();

    await withAuth(handler)(req, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when token is revoked', async () => {
    mockIsRevoked.mockResolvedValue(true);
    const handler = vi.fn();
    const req = makeReq({ cookies: { token: VALID_TOKEN } });
    const res = makeRes();

    await withAuth(handler)(req, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token has been revoked' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 when user no longer exists in DB', async () => {
    (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const handler = vi.fn();
    const req = makeReq({ cookies: { token: VALID_TOKEN } });
    const res = makeRes();

    await withAuth(handler)(req, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 403 when user role does not match requireRole', async () => {
    const handler = vi.fn();
    const req = makeReq({ cookies: { token: VALID_TOKEN } });
    const res = makeRes();

    await withAuth(handler, { requireRole: 'ADMIN' })(req, res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
    expect(handler).not.toHaveBeenCalled();
  });

  describe('viewer role (read-only)', () => {
    beforeEach(() => {
      (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(VIEWER_USER);
    });

    it('allows GET requests for viewer role', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const req = makeReq({ cookies: { token: VALID_TOKEN }, method: 'GET' });
      const res = makeRes();

      await withAuth(handler)(req, res);

      expect(handler).toHaveBeenCalledOnce();
      expect(req.user).toEqual(VIEWER_USER);
    });

    it('blocks POST requests for viewer role with 403', async () => {
      const handler = vi.fn();
      const req = makeReq({ cookies: { token: VALID_TOKEN }, method: 'POST' });
      const res = makeRes();

      await withAuth(handler)(req, res);

      expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
      expect(res.json).toHaveBeenCalledWith({ error: 'Viewer accounts are read-only' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('blocks PUT requests for viewer role with 403', async () => {
      const handler = vi.fn();
      const req = makeReq({ cookies: { token: VALID_TOKEN }, method: 'PUT' });
      const res = makeRes();

      await withAuth(handler)(req, res);

      expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
      expect(handler).not.toHaveBeenCalled();
    });

    it('blocks DELETE requests for viewer role with 403', async () => {
      const handler = vi.fn();
      const req = makeReq({ cookies: { token: VALID_TOKEN }, method: 'DELETE' });
      const res = makeRes();

      await withAuth(handler)(req, res);

      expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
      expect(handler).not.toHaveBeenCalled();
    });

    it('blocks PATCH requests for viewer role with 403', async () => {
      const handler = vi.fn();
      const req = makeReq({ cookies: { token: VALID_TOKEN }, method: 'PATCH' });
      const res = makeRes();

      await withAuth(handler)(req, res);

      expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not block non-GET requests for non-viewer roles', async () => {
      (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(TEST_USER);
      const handler = vi.fn().mockResolvedValue(undefined);
      const req = makeReq({ cookies: { token: VALID_TOKEN }, method: 'POST' });
      const res = makeRes();

      await withAuth(handler)(req, res);

      expect(handler).toHaveBeenCalledOnce();
      expect(req.user).toEqual(TEST_USER);
    });
  });

  describe('optional mode', () => {
    it('calls handler with req.user = null when no token and optional = true', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const req = makeReq();
      const res = makeRes();

      await withAuth(handler, { optional: true })(req, res);

      expect(handler).toHaveBeenCalledOnce();
      expect(req.user).toBeNull();
    });

    it('calls handler with req.user = null on invalid token when optional = true', async () => {
      (mockJwt.verify as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('invalid'); });
      const handler = vi.fn().mockResolvedValue(undefined);
      const req = makeReq({ cookies: { token: 'bad-token' } });
      const res = makeRes();

      await withAuth(handler, { optional: true })(req, res);

      expect(handler).toHaveBeenCalledOnce();
      expect(req.user).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tokens (#84)
// ---------------------------------------------------------------------------

describe('withAuth() — integration tokens', () => {
  const ADMIN_CREATOR = { id: 'user-admin', tenantId: 'tenant-1', email: 'admin@example.com', role: 'admin' };

  let token: string;
  let keyHash: string;
  let prefix: string;

  function keyRow(overrides: Record<string, unknown> = {}, integrationOverrides: Record<string, unknown> = {}) {
    return {
      id: 'key-1',
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      prefix,
      keyHash,
      expiresAt: null,
      revokedAt: null,
      integration: {
        id: 'int-1',
        tenantId: 'tenant-1',
        accessLevel: 'READ_ONLY',
        createdByUserId: ADMIN_CREATOR.id,
        revokedAt: null,
        ...integrationOverrides,
      },
      ...overrides,
    };
  }

  function tokenReq(overrides: Record<string, unknown> = {}) {
    return makeReq({
      method: 'GET',
      url: '/api/transactions',
      headers: { authorization: `Bearer ${token}` },
      ...overrides,
    });
  }

  beforeEach(() => {
    _resetLastUsedThrottle();
    ({ token, keyHash, prefix } = generateApiKey());
    (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(keyRow());
    (mockPrisma.apiKey.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ADMIN_CREATOR);
  });

  it('hydrates req.user as the creator with a capped role and integration metadata', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const req = tokenReq();

    await withAuth(handler)(req, makeRes());

    expect(handler).toHaveBeenCalledOnce();
    expect(req.user).toEqual({
      id: ADMIN_CREATOR.id,
      tenantId: 'tenant-1',
      email: ADMIN_CREATOR.email,
      role: 'viewer',
      authType: 'integration',
      integrationId: 'int-1',
      apiKeyId: 'key-1',
    });
    expect(mockJwt.verify).not.toHaveBeenCalled();
  });

  it('READ_WRITE tokens act as member, never admin', async () => {
    (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(keyRow({}, { accessLevel: 'READ_WRITE' }));
    const handler = vi.fn().mockResolvedValue(undefined);
    const req = tokenReq({ method: 'POST' });

    await withAuth(handler)(req, makeRes());

    expect(handler).toHaveBeenCalledOnce();
    expect(req.user.role).toBe('member');
  });

  it('ignores the session cookie when a bliss_ token is present', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const req = tokenReq({ cookies: { token: VALID_TOKEN } });

    await withAuth(handler)(req, makeRes());

    expect(mockJwt.verify).not.toHaveBeenCalled();
    expect(req.user.authType).toBe('integration');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('READ_ONLY token → 403 READ_ONLY_INTEGRATION on %s', async (method) => {
    const handler = vi.fn();
    const res = makeRes();

    await withAuth(handler)(tokenReq({ method }), res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
    expect(res.json).toHaveBeenCalledWith({ error: 'Read-only integration', code: 'READ_ONLY_INTEGRATION' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('requireRole admin → 403 even for a READ_WRITE token created by an admin', async () => {
    (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(keyRow({}, { accessLevel: 'READ_WRITE' }));
    const handler = vi.fn();
    const res = makeRes();

    await withAuth(handler, { requireRole: 'admin' })(tokenReq({ method: 'POST', url: '/api/admin/rebuild' }), res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
    expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/auth/session'],
    ['PUT', '/api/users'],
    ['GET', '/api/integrations'],
    ['POST', '/api/plaid/create-link-token'],
    ['PUT', '/api/accounts?id=1'],
    ['DELETE', '/api/accounts?id=1'],
    ['PUT', '/api/Accounts/?id=1'],
    ['POST', '/api/accounts/1'],
    ['DELETE', '/api/categories?id=1'],
  ])('denylisted %s %s → 403 NOT_AVAILABLE_TO_INTEGRATIONS', async (method, url) => {
    (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(keyRow({}, { accessLevel: 'READ_WRITE' }));
    const handler = vi.fn();
    const res = makeRes();

    await withAuth(handler)(tokenReq({ method, url }), res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AVAILABLE_TO_INTEGRATIONS' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/api/accounts'],
    ['POST', '/api/Accounts/'],
    ['POST', '/api/x/../accounts'],
    ['POST', '/api/banks'],
  ])('READ_WRITE token reaches the create allowance %s %s (#98)', async (method, url) => {
    (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(keyRow({}, { accessLevel: 'READ_WRITE' }));
    const handler = vi.fn().mockResolvedValue(undefined);

    await withAuth(handler)(tokenReq({ method, url }), makeRes());

    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(['/api/accounts', '/api/banks'])('READ_ONLY token → 403 READ_ONLY_INTEGRATION on POST %s (#98)', async (url) => {
    const handler = vi.fn();
    const res = makeRes();

    await withAuth(handler)(tokenReq({ method: 'POST', url }), res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
    expect(res.json).toHaveBeenCalledWith({ error: 'Read-only integration', code: 'READ_ONLY_INTEGRATION' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a token request without a url (fails closed)', async () => {
    const handler = vi.fn();
    const res = makeRes();

    await withAuth(handler)(tokenReq({ url: undefined }), res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.FORBIDDEN);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['TOKEN_INVALID', () => (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)],
    ['TOKEN_REVOKED', () => (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(keyRow({ revokedAt: new Date() }))],
    ['TOKEN_EXPIRED', () => (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(keyRow({ expiresAt: new Date(Date.now() - 1) }))],
  ])('returns 401 %s', async (code, arrange) => {
    arrange();
    const handler = vi.fn();
    const res = makeRes();

    await withAuth(handler)(tokenReq(), res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 TOKEN_INVALID for a malformed bliss_ token without a DB lookup', async () => {
    const handler = vi.fn();
    const res = makeRes();

    await withAuth(handler)(makeReq({ url: '/api/transactions', headers: { authorization: 'Bearer bliss_garbage' } }), res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_INVALID' }));
    expect(mockPrisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('optional mode: an invalid token yields req.user = null', async () => {
    (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const handler = vi.fn().mockResolvedValue(undefined);
    const req = tokenReq();

    await withAuth(handler, { optional: true })(req, makeRes());

    expect(handler).toHaveBeenCalledOnce();
    expect(req.user).toBeNull();
  });

  it('returns 500 when the key lookup throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const res = makeRes();

    await withAuth(vi.fn())(tokenReq(), res);

    expect(res.status).toHaveBeenCalledWith(StatusCodes.INTERNAL_SERVER_ERROR);
    err.mockRestore();
  });

  it('records lastUsedAt (throttled) on use', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await withAuth(handler)(tokenReq({ headers: { authorization: `Bearer ${token}`, 'x-real-ip': '9.9.9.9' } }), makeRes());
    await withAuth(handler)(tokenReq(), makeRes());
    await new Promise((r) => setTimeout(r, 0));

    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastUsedIp: '9.9.9.9' }),
    }));
  });

  describe('attribution log', () => {
    function captureConsole() {
      const lines: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        }),
      );
      return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
    }

    it('emits exactly one integration_request line per request, with IDs only', async () => {
      const { lines, restore } = captureConsole();
      const res = makeRes();
      res.statusCode = 200;

      await withAuth(vi.fn().mockResolvedValue(undefined))(tokenReq({ url: '/api/transactions?page=2' }), res);
      restore();

      const entries = lines.filter((l) => l.includes('integration_request'));
      expect(entries).toHaveLength(1);
      expect(JSON.parse(entries[0])).toEqual({
        event: 'integration_request',
        tenantId: 'tenant-1',
        integrationId: 'int-1',
        apiKeyId: 'key-1',
        method: 'GET',
        route: '/api/transactions',
        status: 200,
      });
    });

    it('logs on the response finish event when available', async () => {
      const { lines, restore } = captureConsole();
      const listeners: Record<string, () => void> = {};
      const res = makeRes();
      res.statusCode = 201;
      res.once = vi.fn((event: string, cb: () => void) => { listeners[event] = cb; });

      await withAuth(vi.fn().mockResolvedValue(undefined))(tokenReq(), res);
      expect(lines.filter((l) => l.includes('integration_request'))).toHaveLength(0);
      listeners.finish();
      restore();

      const entries = lines.filter((l) => l.includes('integration_request'));
      expect(entries).toHaveLength(1);
      expect(JSON.parse(entries[0]).status).toBe(201);
    });

    it('never logs the token or its secret — success, 401 and 403 alike', async () => {
      const { lines, restore } = captureConsole();
      const secret = token.slice(15);

      await withAuth(vi.fn().mockResolvedValue(undefined))(tokenReq(), makeRes());
      await withAuth(vi.fn())(tokenReq({ method: 'POST' }), makeRes());
      await withAuth(vi.fn())(tokenReq({ url: '/api/users' }), makeRes());
      (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(keyRow({ revokedAt: new Date() }));
      await withAuth(vi.fn())(tokenReq(), makeRes());
      (mockPrisma.apiKey.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(`boom ${token}`));
      await withAuth(vi.fn())(tokenReq(), makeRes());
      restore();

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain(keyHash);
      }
    });
  });
});
