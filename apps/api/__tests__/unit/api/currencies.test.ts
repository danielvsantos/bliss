/**
 * Unit tests for /api/currencies
 *
 * Note: currencies.js does NOT use withAuth — it's a public reference endpoint.
 * Mocked handler pattern: cors, rateLimit, Sentry, and Prisma are all mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: (_req: unknown, _res: unknown) => false,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    currency: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/currencies.js';

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

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/currencies', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns currencies ordered alphabetically', async () => {
    const currencies = [
      { id: 'EUR', name: 'Euro', symbol: 'E' },
      { id: 'GBP', name: 'British Pound', symbol: 'P' },
      { id: 'USD', name: 'US Dollar', symbol: '$' },
    ];
    mockPrisma.currency.findMany.mockResolvedValueOnce(currencies);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(currencies);
    expect(mockPrisma.currency.findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, symbol: true },
      orderBy: { name: 'asc' },
    });
  });

  it('returns expected fields (id, name, symbol)', async () => {
    const currencies = [{ id: 'USD', name: 'US Dollar', symbol: '$' }];
    mockPrisma.currency.findMany.mockResolvedValueOnce(currencies);

    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const item = res._body[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('symbol');
    expect(Object.keys(item)).toEqual(['id', 'name', 'symbol']);
  });
});
