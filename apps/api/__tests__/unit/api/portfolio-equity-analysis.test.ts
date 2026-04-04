/**
 * Unit tests for GET /api/portfolio/equity-analysis
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

// Mock valuation service — return a live price
vi.mock('../../../services/valuation.service.js', () => ({
  calculateAssetCurrentValue: vi.fn().mockResolvedValue(new Decimal(150)),
}));

// Mock currency conversion — identity passthrough
vi.mock('../../../utils/currencyConversion.js', () => ({
  convertCurrency: vi.fn().mockImplementation(async (amount: any) => amount),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenant: {
      findUnique: vi.fn(),
    },
    portfolioItem: {
      findMany: vi.fn(),
    },
    securityMaster: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/portfolio/equity-analysis.js';

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

describe('GET /api/portfolio/equity-analysis', () => {
  it('returns 405 for non-GET methods', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
  });

  it('returns sector groupings with weighted metrics', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });

    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
      {
        id: 1,
        symbol: 'AAPL',
        currency: 'USD',
        assetCurrency: 'USD',
        quantity: new Decimal(10),
        costBasis: new Decimal(1400),
        currentValue: new Decimal(1500),
        costBasisInUSD: new Decimal(1400),
        currentValueInUSD: new Decimal(1500),
        source: 'PLAID',
        category: { name: 'Stocks', group: 'US Equities', processingHint: 'API_STOCK' },
      },
    ]);

    mockPrisma.securityMaster.findMany.mockResolvedValueOnce([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        country: 'US',
        peRatio: new Decimal(28.5),
        dividendYield: new Decimal(0.005),
        trailingEps: new Decimal(6.2),
        latestEpsActual: new Decimal(1.46),
        latestEpsSurprise: new Decimal(0.04),
        week52High: new Decimal(200),
        week52Low: new Decimal(140),
        averageVolume: new Decimal(55000000),
        logoUrl: 'https://logo.clearbit.com/apple.com',
      },
    ]);

    const req = makeReq({ query: { groupBy: 'sector' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.portfolioCurrency).toBe('USD');
    expect(res._body.summary.holdingsCount).toBe(1);
    expect(res._body.summary.weightedPeRatio).toBeGreaterThan(0);
    expect(res._body.groups).toHaveLength(1);
    expect(res._body.groups[0].name).toBe('Technology');
    expect(res._body.groups[0].holdings).toHaveLength(1);
    expect(res._body.groups[0].holdings[0].symbol).toBe('AAPL');
  });

  it('returns empty when no stock holdings', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });
    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.summary.holdingsCount).toBe(0);
    expect(res._body.summary.totalEquityValue).toBe(0);
    expect(res._body.groups).toEqual([]);
  });

  it('handles missing SecurityMaster data gracefully', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({ portfolioCurrency: 'USD' });

    mockPrisma.portfolioItem.findMany.mockResolvedValueOnce([
      {
        id: 2,
        symbol: 'XYZ',
        currency: 'USD',
        assetCurrency: 'USD',
        quantity: new Decimal(5),
        costBasis: new Decimal(500),
        currentValue: new Decimal(600),
        costBasisInUSD: new Decimal(500),
        currentValueInUSD: new Decimal(600),
        source: 'MANUAL',
        category: { name: 'Stocks', group: 'US Equities', processingHint: 'API_STOCK' },
      },
    ]);

    // No SecurityMaster records for this symbol
    mockPrisma.securityMaster.findMany.mockResolvedValueOnce([]);

    const req = makeReq({});
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.summary.holdingsCount).toBe(1);
    // Missing SM data should default to 'Unknown'
    const holding = res._body.groups[0].holdings[0];
    expect(holding.sector).toBe('Unknown');
    expect(holding.industry).toBe('Unknown');
    expect(holding.peRatio).toBeNull();
    expect(holding.dividendYield).toBeNull();
    // Weighted metrics should be null when no PE data
    expect(res._body.summary.weightedPeRatio).toBeNull();
  });
});
