/**
 * Unit tests for PUT /api/portfolio/items/:assetId/asset-class (Equity Analysis #79).
 *
 * Mocked-handler pattern: withAuth, rate limiter, cors, Sentry and Prisma are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

vi.mock('../../../utils/withAuth.js', () => ({
  withAuth: (handler: any) => async (req: any, res: any) => {
    req.user = { id: 1, tenantId: 'tenant-a', role: 'admin', email: 'a@test.com' };
    return handler(req, res);
  },
}));

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));

const { mockSentry } = vi.hoisted(() => ({ mockSentry: { captureException: vi.fn() } }));
vi.mock('@sentry/nextjs', () => mockSentry);

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    portfolioItem: { findFirst: vi.fn(), updateMany: vi.fn() },
    securityMaster: { findUnique: vi.fn() },
  },
}));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/portfolio/items/[assetId]/asset-class.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'PUT', headers: {}, cookies: {}, body: {}, query: { assetId: '7' }, ...overrides } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

const QQQ_ITEM = {
  id: 7,
  symbol: 'QQQ',
  category: { group: 'ETFs', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS' },
  incomeTerms: null,
};

async function call(req: NextApiRequest) {
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.portfolioItem.findFirst.mockResolvedValue(QQQ_ITEM);
  mockPrisma.portfolioItem.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.securityMaster.findUnique.mockResolvedValue({
    assetType: 'ETF', name: 'Invesco QQQ Trust',
    etfComposition: { sectors: [{ sector: 'Technology', weight: 0.5915 }], countries: [], assetAllocation: { bonds: 0 } },
  });
});

describe('PUT /api/portfolio/items/:assetId/asset-class', () => {
  it('rejects other methods', async () => {
    const res = await call(makeReq({ method: 'DELETE' }));
    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PUT']);
  });

  it('rejects a non-numeric id', async () => {
    const res = await call(makeReq({ query: { assetId: 'abc' }, body: { assetClass: 'FUND' } }));
    expect(res._status).toBe(400);
  });

  it('rejects an unknown asset class and a missing value', async () => {
    expect((await call(makeReq({ body: { assetClass: 'BANANA' } })))._status).toBe(400);
    expect((await call(makeReq({ body: {} })))._status).toBe(400);
    expect((await call(makeReq({ body: undefined })))._status).toBe(400);
    expect(mockPrisma.portfolioItem.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 for an item of another tenant', async () => {
    mockPrisma.portfolioItem.findFirst.mockResolvedValue(null);
    const res = await call(makeReq({ body: { assetClass: 'SECTOR_ETF' } }));
    expect(res._status).toBe(404);
    expect(mockPrisma.portfolioItem.findFirst.mock.calls[0][0].where).toEqual({ id: 7, tenantId: 'tenant-a' });
    expect(mockPrisma.portfolioItem.updateMany).not.toHaveBeenCalled();
  });

  it('sets the override on the item and returns the recomputed class', async () => {
    const res = await call(makeReq({ body: { assetClass: 'SECTOR_ETF' } }));
    expect(res._status).toBe(200);
    expect(mockPrisma.portfolioItem.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', id: 7 },
      data: { assetClassOverride: 'SECTOR_ETF' },
    });
    expect(res._body).toEqual({ assetClass: 'SECTOR_ETF', assetClassSource: 'OVERRIDE', autoAssetClass: 'INDEX_ETF', updatedCount: 1 });
  });

  it('applies to every holding of the symbol in the tenant when asked', async () => {
    mockPrisma.portfolioItem.updateMany.mockResolvedValue({ count: 2 });
    const res = await call(makeReq({ body: { assetClass: 'FUND', applyToSymbol: true } }));
    expect(mockPrisma.portfolioItem.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', symbol: 'QQQ' },
      data: { assetClassOverride: 'FUND' },
    });
    expect(res._body.updatedCount).toBe(2);
  });

  it('clears the override with null and falls back to the automatic class', async () => {
    mockPrisma.securityMaster.findUnique.mockResolvedValue(null);
    mockPrisma.portfolioItem.findFirst.mockResolvedValue({
      ...QQQ_ITEM, symbol: 'KO', category: { group: 'Stocks', processingHint: 'API_STOCK', defaultCategoryCode: 'STOCKS' },
    });
    const res = await call(makeReq({ body: { assetClass: null } }));
    expect(mockPrisma.portfolioItem.updateMany.mock.calls[0][0].data).toEqual({ assetClassOverride: null });
    expect(res._body).toMatchObject({ assetClass: 'STOCK', assetClassSource: 'AUTO', autoAssetClass: 'STOCK' });
  });

  it('returns 500 and reports to Sentry on a database error', async () => {
    mockPrisma.portfolioItem.updateMany.mockRejectedValue(new Error('db down'));
    const res = await call(makeReq({ body: { assetClass: 'FUND' } }));
    expect(res._status).toBe(500);
    expect(mockSentry.captureException).toHaveBeenCalled();
  });
});

describe('GET /api/portfolio/items/:assetId/asset-class (Manage Assets #81)', () => {
  it('returns the current class, its source and the automatic class', async () => {
    mockPrisma.portfolioItem.findFirst.mockResolvedValue({ ...QQQ_ITEM, assetClassOverride: 'SECTOR_ETF' });
    const res = await call(makeReq({ method: 'GET' }));
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ assetClass: 'SECTOR_ETF', assetClassSource: 'OVERRIDE', autoAssetClass: 'INDEX_ETF' });
    expect(mockPrisma.portfolioItem.findFirst.mock.calls[0][0].where).toEqual({ id: 7, tenantId: 'tenant-a' });
    expect(mockPrisma.portfolioItem.updateMany).not.toHaveBeenCalled();
  });

  it('reports AUTO when there is no override', async () => {
    mockPrisma.portfolioItem.findFirst.mockResolvedValue({ ...QQQ_ITEM, assetClassOverride: null });
    const res = await call(makeReq({ method: 'GET' }));
    expect(res._body).toEqual({ assetClass: 'INDEX_ETF', assetClassSource: 'AUTO', autoAssetClass: 'INDEX_ETF' });
  });

  it('returns 404 for an item of another tenant', async () => {
    mockPrisma.portfolioItem.findFirst.mockResolvedValue(null);
    expect((await call(makeReq({ method: 'GET' })))._status).toBe(404);
  });

  it('returns 500 on a database error', async () => {
    mockPrisma.portfolioItem.findFirst.mockRejectedValue(new Error('db down'));
    expect((await call(makeReq({ method: 'GET' })))._status).toBe(500);
    expect(mockSentry.captureException).toHaveBeenCalled();
  });
});
