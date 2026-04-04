/**
 * Unit tests for GET /api/portfolio/items
 *
 * Uses the mocked-handler pattern: withAuth, rate limiter, cors, Sentry,
 * Prisma, valuation service, and currency conversion are all mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Decimal } from '@prisma/client/runtime/library';

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

// Mock valuation service — return zero so stored values are used
vi.mock('../../../services/valuation.service.js', () => ({
  calculateAssetCurrentValue: vi.fn().mockResolvedValue(new Decimal(0)),
}));

// Mock currency conversion — identity passthrough
vi.mock('../../../utils/currencyConversion.js', () => ({
  convertCurrency: vi.fn().mockResolvedValue(null),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenant: {
      findUnique: vi.fn(),
    },
    portfolioItem: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/portfolio/items.js';

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
// Helper to build a DB asset row
// ---------------------------------------------------------------------------

function makeDbAsset(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    symbol: 'AAPL',
    source: 'PLAID',
    currency: 'USD',
    exchange: 'NASDAQ',
    assetCurrency: 'USD',
    quantity: new Decimal(10),
    costBasis: new Decimal(1500),
    realizedPnL: new Decimal(0),
    currentValue: new Decimal(1700),
    totalInvested: new Decimal(1500),
    costBasisInUSD: new Decimal(1500),
    currentValueInUSD: new Decimal(1700),
    realizedPnLInUSD: new Decimal(0),
    totalInvestedInUSD: new Decimal(1500),
    category: {
      name: 'Stocks',
      group: 'US Equities',
      type: 'Investments',
      icon: 'chart-line',
      processingHint: 'API_STOCK',
    },
    debtTerms: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/portfolio/items', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns portfolio items with enriched data', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([makeDbAsset()]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.portfolioCurrency).toBe('USD');
    expect(res._body.items).toHaveLength(1);

    const item = res._body.items[0];
    expect(item.symbol).toBe('AAPL');
    expect(item.category.name).toBe('Stocks');
    // native and usd blocks should exist
    expect(item.native).toBeDefined();
    expect(item.usd).toBeDefined();
    expect(item.usd.costBasis).toBeInstanceOf(Decimal);
  });

  it('fetches portfolio currency from tenant', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'EUR' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.portfolioCurrency).toBe('EUR');
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 'test-tenant-123' },
      select: { portfolioCurrency: true },
    });
  });

  it('includes manual values when include_manual_values=true', async () => {
    const assetWithManualValues = makeDbAsset({
      manualValues: [{ id: 'mv-1', date: new Date('2026-01-01'), value: new Decimal(2000), currency: 'USD' }],
    });
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([assetWithManualValues]);

    const req = makeReq({ query: { include_manual_values: 'true' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const item = res._body.items[0];
    expect(item.manualValues).toBeDefined();
    expect(item.manualValues).toHaveLength(1);

    // Verify the select clause included manualValues
    expect(mockPrisma.portfolioItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          manualValues: expect.any(Object),
        }),
      }),
    );
  });

  it('returns empty array when no items', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.items).toEqual([]);
  });
});
