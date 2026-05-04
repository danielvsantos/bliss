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
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));
vi.mock('../../../utils/cookieUtils.js', () => ({ setAuthCookie: vi.fn() }));

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
  res.setHeader = vi.fn(() => res);
  res.redirect = vi.fn((url: string) => { res._redirectUrl = url; return res; });
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET_CURRENT = 'test-jwt-secret';
  process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
  process.env.FRONTEND_URL = 'http://localhost:8080';
});

describe('GET /api/auth/google-token', () => {
  it('exchanges token and redirects to frontend callback', async () => {
    mockGetToken.mockResolvedValue({ id: 1, email: 'user@test.com', isNew: false });
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
    mockGetToken.mockResolvedValue({ id: 1, email: 'new@test.com', isNew: true });
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
});
