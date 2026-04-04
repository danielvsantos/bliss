/**
 * Unit tests for /api/portfolio/items/[assetId]/manual-values
 *
 * Uses the mocked-handler pattern: withAuth, rate limiter, cors, Sentry,
 * Prisma, and produceEvent are all mocked so we test the handler logic in isolation.
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

const { mockProduceEvent } = vi.hoisted(() => ({
  mockProduceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: mockProduceEvent,
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    manualAssetValue: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    portfolioItem: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/portfolio/items/[assetId]/manual-values.js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: {},
    cookies: {},
    body: {},
    query: { assetId: '42' },
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
  mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/api/portfolio/items/[assetId]/manual-values', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'DELETE' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST']);
  });

  describe('GET', () => {
    it('returns manual values ordered by date desc', async () => {
      const values = [
        { id: 'mv-2', assetId: 42, tenantId: 'test-tenant-123', date: new Date('2026-03-01'), value: new Decimal(2500), currency: 'USD', notes: null },
        { id: 'mv-1', assetId: 42, tenantId: 'test-tenant-123', date: new Date('2026-02-01'), value: new Decimal(2000), currency: 'USD', notes: null },
      ];
      mockPrisma.manualAssetValue.findMany.mockResolvedValueOnce(values);

      const req = makeReq({ method: 'GET', query: { assetId: '42' } });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(200);
      expect(res._body).toHaveLength(2);
      expect(res._body[0].id).toBe('mv-2');
      expect(mockPrisma.manualAssetValue.findMany).toHaveBeenCalledWith({
        where: { assetId: 42, tenantId: 'test-tenant-123' },
        orderBy: { date: 'desc' },
      });
    });
  });

  describe('POST', () => {
    it('creates manual value and fires event', async () => {
      const asset = { id: 42, tenantId: 'test-tenant-123' };
      mockPrisma.portfolioItem.findFirst.mockResolvedValueOnce(asset);

      const createdValue = {
        id: 'mv-3',
        assetId: 42,
        tenantId: 'test-tenant-123',
        date: new Date('2026-04-01'),
        value: new Decimal(3000),
        currency: 'USD',
        notes: 'Q1 valuation',
      };
      mockPrisma.manualAssetValue.create.mockResolvedValueOnce(createdValue);

      const req = makeReq({
        method: 'POST',
        query: { assetId: '42' },
        body: { date: '2026-04-01', value: 3000, currency: 'USD', notes: 'Q1 valuation' },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(201);
      expect(res._body).toEqual(createdValue);
      expect(mockProduceEvent).toHaveBeenCalledWith({
        type: 'MANUAL_PORTFOLIO_PRICE_UPDATED',
        portfolioItemId: 42,
        tenantId: 'test-tenant-123',
      });
    });

    it('returns 400 for missing required fields', async () => {
      const req = makeReq({
        method: 'POST',
        query: { assetId: '42' },
        body: { date: '2026-04-01' }, // missing value and currency
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(400);
      expect(res._body.error).toContain('Missing required fields');
    });

    it('validates asset belongs to tenant', async () => {
      // Asset not found for this tenant
      mockPrisma.portfolioItem.findFirst.mockResolvedValueOnce(null);

      const req = makeReq({
        method: 'POST',
        query: { assetId: '42' },
        body: { date: '2026-04-01', value: 3000, currency: 'USD' },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(404);
      expect(res._body.error).toContain('not found');
    });
  });
});
