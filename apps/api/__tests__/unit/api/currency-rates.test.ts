/**
 * Unit tests for /api/currency-rates
 *
 * Mocked handler pattern: withAuth, cors, rateLimit, Sentry, and Prisma
 * are all mocked so we test handler logic in isolation.
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

const mockUser = { id: 1, tenantId: 'test-tenant-123', role: 'admin', email: 'admin@test.com' };

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => {
    return async (req: any, res: any) => {
      req.user = { ...mockUser };
      return handler(req, res);
    };
  },
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
    currencyRate: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    tenantCurrency: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/currency-rates.js';

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
// Helper: mock tenant currency validation (both valid)
// ---------------------------------------------------------------------------

function mockValidCurrencies() {
  mockPrisma.tenantCurrency.findFirst
    .mockResolvedValueOnce({ currencyId: 'USD', currency: { id: 'USD', name: 'US Dollar' } })
    .mockResolvedValueOnce({ currencyId: 'EUR', currency: { id: 'EUR', name: 'Euro' } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/currency-rates', () => {
  it('returns rates for tenant', async () => {
    const tenantCurrencies = [{ currencyId: 'USD' }, { currencyId: 'EUR' }];
    mockPrisma.tenantCurrency.findMany.mockResolvedValueOnce(tenantCurrencies);

    const rates = [
      { id: 1, year: 2026, month: 1, day: 15, currencyFrom: 'USD', currencyTo: 'EUR', value: 0.92 },
    ];
    mockPrisma.currencyRate.findMany.mockResolvedValueOnce(rates);

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(rates);
  });
});

describe('POST /api/currency-rates', () => {
  it('creates/upserts rate', async () => {
    mockValidCurrencies();

    const newRate = {
      id: 10, year: 2026, month: 3, day: 1,
      currencyFrom: 'USD', currencyTo: 'EUR', value: 0.93, provider: 'manual',
    };
    mockPrisma.currencyRate.upsert.mockResolvedValueOnce(newRate);

    const req = makeReq({
      method: 'POST',
      body: {
        year: 2026, month: 3, day: 1,
        currencyFrom: 'USD', currencyTo: 'EUR', value: 0.93, provider: 'manual',
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(201);
    expect(res._body).toEqual(newRate);
  });

  it('returns 400 for same-currency conversion', async () => {
    mockPrisma.tenantCurrency.findFirst
      .mockResolvedValueOnce({ currencyId: 'USD', currency: { id: 'USD' } })
      .mockResolvedValueOnce({ currencyId: 'USD', currency: { id: 'USD' } });

    const req = makeReq({
      method: 'POST',
      body: {
        year: 2026, month: 3, day: 1,
        currencyFrom: 'USD', currencyTo: 'USD', value: 1.0,
      },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toBe('Invalid currency pair');
  });
});

describe('DELETE /api/currency-rates', () => {
  it('removes rate', async () => {
    const existing = { id: 5, currencyFrom: 'USD', currencyTo: 'EUR' };
    mockPrisma.currencyRate.findUnique.mockResolvedValueOnce(existing);
    mockValidCurrencies();
    mockPrisma.currencyRate.delete.mockResolvedValueOnce(existing);

    const req = makeReq({ method: 'DELETE', query: { id: '5' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(204);
    expect(mockPrisma.currencyRate.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });
});

describe('Method validation', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'PATCH' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
  });
});
