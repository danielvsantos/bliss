/**
 * Unit tests for /api/portfolio/items/[assetId]/manual-values/[valueId]
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
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/portfolio/items/[assetId]/manual-values/[valueId].js';

// ---------------------------------------------------------------------------
// req / res factories
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'PUT',
    headers: {},
    cookies: {},
    body: {},
    query: { assetId: '42', valueId: 'mv-1' },
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

describe('/api/portfolio/items/[assetId]/manual-values/[valueId]', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['PUT', 'DELETE']);
  });

  describe('PUT', () => {
    it('updates manual value and fires event', async () => {
      const existingValue = {
        id: 'mv-1',
        assetId: 42,
        tenantId: 'test-tenant-123',
        date: new Date('2026-03-01'),
        value: new Decimal(2000),
        currency: 'USD',
        notes: null,
      };
      mockPrisma.manualAssetValue.findFirst.mockResolvedValueOnce(existingValue);

      const updatedValue = { ...existingValue, value: new Decimal(2500), notes: 'Updated' };
      mockPrisma.manualAssetValue.update.mockResolvedValueOnce(updatedValue);

      const req = makeReq({
        method: 'PUT',
        query: { assetId: '42', valueId: 'mv-1' },
        body: { value: 2500, notes: 'Updated' },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(200);
      expect(res._body.value).toEqual(new Decimal(2500));
      expect(mockProduceEvent).toHaveBeenCalledWith({
        type: 'MANUAL_PORTFOLIO_PRICE_UPDATED',
        portfolioItemId: 42,
        tenantId: 'test-tenant-123',
      });
    });

    it('returns 404 when value not found', async () => {
      mockPrisma.manualAssetValue.findFirst.mockResolvedValueOnce(null);

      const req = makeReq({
        method: 'PUT',
        query: { assetId: '42', valueId: 'mv-nonexistent' },
        body: { value: 2500 },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(404);
      expect(res._body.error).toContain('not found');
    });
  });

  describe('DELETE', () => {
    it('removes manual value and fires event', async () => {
      const existingValue = {
        id: 'mv-1',
        assetId: 42,
        tenantId: 'test-tenant-123',
        date: new Date('2026-03-01'),
        value: new Decimal(2000),
        currency: 'USD',
        notes: null,
      };
      mockPrisma.manualAssetValue.findFirst.mockResolvedValueOnce(existingValue);
      mockPrisma.manualAssetValue.delete.mockResolvedValueOnce(existingValue);

      const req = makeReq({
        method: 'DELETE',
        query: { assetId: '42', valueId: 'mv-1' },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(204);
      expect(mockProduceEvent).toHaveBeenCalledWith({
        type: 'MANUAL_PORTFOLIO_PRICE_UPDATED',
        portfolioItemId: 42,
        tenantId: 'test-tenant-123',
      });
    });

    it('returns 404 when value not found for deletion', async () => {
      mockPrisma.manualAssetValue.findFirst.mockResolvedValueOnce(null);

      const req = makeReq({
        method: 'DELETE',
        query: { assetId: '42', valueId: 'mv-nonexistent' },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(404);
      expect(res._body.error).toContain('not found');
    });
  });
});
