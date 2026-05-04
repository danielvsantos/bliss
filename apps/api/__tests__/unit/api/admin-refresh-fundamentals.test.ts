/**
 * Unit tests for POST /api/admin/refresh-fundamentals
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

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), init: vi.fn() }));

vi.mock('../../../utils/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../../utils/fetchWithTimeout.js';
const mockFetchWithTimeout = fetchWithTimeout as ReturnType<typeof vi.fn>;

import handler from '../../../pages/api/admin/refresh-fundamentals.js';

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

describe('POST /api/admin/refresh-fundamentals', () => {
  it('triggers refresh and forwards backend 202 response', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      status: 202,
      json: async () => ({ message: 'refresh started', jobId: 'job-123' }),
    });

    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    expect(res._body.jobId).toBe('job-123');
  });

  it('returns 500 when INTERNAL_API_KEY is not set', async () => {
    delete process.env.INTERNAL_API_KEY;

    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(res._body.error).toMatch(/backend not configured/i);
  });

  it('returns 405 for GET', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });

  it('returns 500 on fetch error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('Network error'));

    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(res._body.error).toMatch(/unexpected error/i);
  });
});
