import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusCodes } from 'http-status-codes';

// Mock all external dependencies before importing the module under test
vi.mock('jsonwebtoken', () => ({
  default: { verify: vi.fn() },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
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
