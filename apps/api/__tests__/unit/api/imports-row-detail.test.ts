/**
 * Unit tests for PUT /api/imports/[id]/rows/[rowId]
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
  withAuth: (handler: any) => async (req: any, res: any) => {
    req.user = { ...mockUser };
    return handler(req, res);
  },
}));

vi.mock('../../../utils/cors.js', () => ({
  cors: () => false,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stagedImportRow: { findUnique: vi.fn(), update: vi.fn() },
    category: { findFirst: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import handler from '../../../pages/api/imports/[id]/rows/[rowId].js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'PUT', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

const baseRow = {
  id: 'row-1',
  stagedImportId: 'import-1',
  description: 'Coffee',
  status: 'PENDING',
  stagedImport: { id: 'import-1', tenantId: 'tenant-abc', status: 'PROCESSING' },
};

describe('PUT /api/imports/[id]/rows/[rowId]', () => {
  it('updates row status and category', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue(baseRow);
    mockPrisma.category.findFirst.mockResolvedValue({ id: 5, tenantId: 'tenant-abc' });
    mockPrisma.stagedImportRow.update.mockResolvedValue({ ...baseRow, status: 'CONFIRMED', suggestedCategoryId: 5 });

    const req = makeReq({
      query: { id: 'import-1', rowId: 'row-1' },
      body: { status: 'CONFIRMED', suggestedCategoryId: 5 },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
  });

  // Private / unlisted funds have no ticker: quantity + price must clear the flag.
  describe('investment enrichment', () => {
    const funds = { id: 30, type: 'Investments', processingHint: 'API_FUND' };
    const stocks = { id: 31, type: 'Investments', processingHint: 'API_STOCK' };
    const flagged = { ...baseRow, requiresEnrichment: true, enrichmentType: 'INVESTMENT', ticker: null, assetQuantity: null, assetPrice: null };

    async function put(row: any, category: any, body: any) {
      mockPrisma.stagedImportRow.findUnique.mockResolvedValue(row);
      mockPrisma.category.findFirst.mockResolvedValue(category);
      mockPrisma.stagedImportRow.update.mockImplementation(async ({ data }: any) => ({ ...row, ...data }));
      const res = makeRes();
      await handler(makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body }) as NextApiRequest, res as unknown as NextApiResponse);
      expect(res._status).toBe(200);
      return mockPrisma.stagedImportRow.update.mock.calls.at(-1)![0].data;
    }

    it('clears the flag on a ticker-less fund row once quantity + price are entered', async () => {
      const data = await put({ ...flagged, suggestedCategoryId: 30 }, funds, { assetQuantity: '10', assetPrice: '1000' });
      expect(data.requiresEnrichment).toBe(false);
    });

    it('keeps the flag on a ticker-less stock row', async () => {
      const data = await put({ ...flagged, suggestedCategoryId: 31 }, stocks, { assetQuantity: '10', assetPrice: '50' });
      expect(data).not.toHaveProperty('requiresEnrichment', false);
    });

    it('re-categorising into Funds with quantity + price and no ticker needs no enrichment', async () => {
      const data = await put({ ...baseRow, suggestedCategoryId: 5 }, funds, { suggestedCategoryId: 30, assetQuantity: 10, assetPrice: 1000 });
      expect(data.requiresEnrichment).toBe(false);
    });

    it('re-categorising into Stocks without a ticker flags the row', async () => {
      const data = await put({ ...baseRow, suggestedCategoryId: 5 }, stocks, { suggestedCategoryId: 31, assetQuantity: 10, assetPrice: 50 });
      expect(data).toMatchObject({ requiresEnrichment: true, enrichmentType: 'INVESTMENT' });
    });
  });

  it('returns 404 when row not found', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue(null);

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-x' }, body: { status: 'CONFIRMED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 404 when row belongs to different tenant', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue({
      ...baseRow,
      stagedImport: { id: 'import-1', tenantId: 'other-tenant', status: 'PROCESSING' },
    });

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body: { status: 'CONFIRMED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns 400 when row does not belong to this import', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue({
      ...baseRow,
      stagedImportId: 'other-import',
    });

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body: { status: 'CONFIRMED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/does not belong/i);
  });

  it('returns 400 when import is COMMITTED', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue({
      ...baseRow,
      stagedImport: { id: 'import-1', tenantId: 'tenant-abc', status: 'COMMITTED' },
    });

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body: { status: 'CONFIRMED' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/committed/i);
  });

  it('returns 400 for invalid status override', async () => {
    mockPrisma.stagedImportRow.findUnique.mockResolvedValue(baseRow);

    const req = makeReq({ query: { id: 'import-1', rowId: 'row-1' }, body: { status: 'INVALID_STATUS' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
  });

  it('returns 405 for non-PUT methods', async () => {
    const req = makeReq({ method: 'GET', query: { id: 'import-1', rowId: 'row-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
