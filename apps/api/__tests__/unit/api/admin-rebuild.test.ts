/**
 * Unit tests for GET/POST /api/admin/rebuild
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'tenant-abc', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any, _opts?: any) => async (req: any, res: any) => {
    req.user = { ...mockUser };
    return handler(req, res);
  },
}));

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

vi.mock('../../../utils/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../../utils/fetchWithTimeout.js';
const mockFetchWithTimeout = fetchWithTimeout as ReturnType<typeof vi.fn>;

import handler from '../../../pages/api/admin/rebuild.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'POST', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_API_KEY = 'test-internal-key';
});

describe('POST /api/admin/rebuild', () => {
  it('triggers full-portfolio rebuild and returns 202', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      status: 202,
      json: async () => ({ status: 'accepted', scope: 'full-portfolio' }),
    });

    const req = makeReq({ method: 'POST', body: { scope: 'full-portfolio' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
  });

  it('returns 400 for invalid scope', async () => {
    const req = makeReq({ method: 'POST', body: { scope: 'invalid-scope' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/scope must be one of/i);
  });

  it('returns 400 when scoped-analytics missing earliestDate', async () => {
    const req = makeReq({ method: 'POST', body: { scope: 'scoped-analytics', payload: {} } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/earliestDate/i);
  });

  it('returns 400 when single-asset missing portfolioItemId', async () => {
    const req = makeReq({ method: 'POST', body: { scope: 'single-asset', payload: {} } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/portfolioItemId/i);
  });

  it('triggers scoped-analytics with valid earliestDate', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      status: 202,
      json: async () => ({ status: 'accepted' }),
    });

    const req = makeReq({
      method: 'POST',
      body: { scope: 'scoped-analytics', payload: { earliestDate: '2025-01-01' } },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
  });

  it('triggers single-asset with valid portfolioItemId', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      status: 202,
      json: async () => ({ status: 'accepted' }),
    });

    const req = makeReq({
      method: 'POST',
      body: { scope: 'single-asset', payload: { portfolioItemId: 42 } },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
  });

  it('forwards 409 from backend (already running)', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      status: 409,
      json: async () => ({ error: 'Already running', ttlSeconds: 30 }),
    });

    const req = makeReq({ method: 'POST', body: { scope: 'full-analytics' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(409);
  });
});

describe('GET /api/admin/rebuild', () => {
  it('returns rebuild status from backend', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      status: 200,
      json: async () => ({ locks: {}, current: null, recent: [] }),
    });

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toHaveProperty('locks');
  });
});

describe('405 guard', () => {
  it('returns 405 for PATCH', async () => {
    const req = makeReq({ method: 'PATCH' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});

describe('backend not configured', () => {
  it('returns 500 when INTERNAL_API_KEY is not set', async () => {
    delete process.env.INTERNAL_API_KEY;

    const req = makeReq({ method: 'POST', body: { scope: 'full-portfolio' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(res._body.error).toMatch(/backend not configured/i);
  });
});
