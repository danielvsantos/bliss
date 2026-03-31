/**
 * Integration tests for GET /api/ticker/search
 *
 * Calls the Next.js handler directly with factory-built req/res objects.
 * withAuth and rate limiter are mocked so we can test the handler logic
 * in isolation without a real JWT or Redis.
 *
 * Global fetch is mocked to simulate the backend proxy call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Mock withAuth to inject a test user without real JWT verification
vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { id: 1, tenantId: 'test-tenant', role: 'admin', email: 'test@test.com' };
      return handler(req, res);
    };
  },
}));

// Mock cors to no-op (returns false so handler continues)
vi.mock('../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

// Mock Sentry
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

import handler from '../../../pages/api/ticker/search.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
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
// Global fetch mock
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /api/ticker/search', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res._body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when q query param is missing', async () => {
    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'q query param is required' });
  });

  it('returns 400 when q query param is an empty string', async () => {
    const req = makeReq({ method: 'GET', query: { q: '   ' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'q query param is required' });
  });

  it('returns 200 with ticker search results on success', async () => {
    const mockResults = {
      results: [
        {
          symbol: 'AAPL',
          name: 'Apple Inc',
          exchange: 'NASDAQ',
          country: 'United States',
          currency: 'USD',
          type: 'Common Stock',
          mic_code: 'XNGS',
        },
      ],
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResults,
    });

    const req = makeReq({ method: 'GET', query: { q: 'AAPL' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(mockResults);

    // Verify fetch was called with correct URL and API key header
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOpts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchUrl).toContain('/api/ticker/search');
    expect(fetchUrl).toContain('q=AAPL');
    expect(fetchOpts.headers['x-api-key']).toBeDefined();
  });

  it('returns 500 when backend responds with an error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    });

    const req = makeReq({ method: 'GET', query: { q: 'AAPL' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to search tickers' });
  });

  it('returns 500 when fetch throws a network error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Network failure')
    );

    const req = makeReq({ method: 'GET', query: { q: 'AAPL' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Server Error');
  });
});
