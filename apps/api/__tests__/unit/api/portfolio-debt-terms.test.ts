/**
 * Unit tests for /api/portfolio/items/[assetId]/debt-terms
 *
 * Uses the mocked-handler pattern: withAuth, rate limiter, cors, Sentry,
 * and Prisma are all mocked so we test the handler logic in isolation.
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

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    debtTerms: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
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

import handler from '../../../pages/api/portfolio/items/[assetId]/debt-terms.js';

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
  // Default: $transaction executes the callback with mockPrisma
  mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/api/portfolio/items/[assetId]/debt-terms', () => {
  describe('Method validation', () => {
    it('returns 405 for unsupported methods', async () => {
      const req = makeReq({ method: 'DELETE' });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(405);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'POST', 'PUT']);
    });
  });

  describe('GET', () => {
    it('returns debt terms for an asset', async () => {
      const debtTermsData = {
        id: 1,
        assetId: 42,
        initialBalance: new Decimal(250000),
        interestRate: new Decimal(4.5),
        termInMonths: 360,
        originationDate: new Date('2024-01-01'),
      };
      mockPrisma.debtTerms.findFirst.mockResolvedValueOnce(debtTermsData);

      const req = makeReq({ method: 'GET', query: { assetId: '42' } });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(200);
      expect(res._body).toEqual(debtTermsData);
      expect(mockPrisma.debtTerms.findFirst).toHaveBeenCalledWith({
        where: {
          assetId: 42,
          asset: { tenantId: 'test-tenant-123' },
        },
      });
    });

    it('returns 404 when debt terms not found', async () => {
      mockPrisma.debtTerms.findFirst.mockResolvedValueOnce(null);

      const req = makeReq({ method: 'GET', query: { assetId: '42' } });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(404);
    });
  });

  describe('POST', () => {
    it('creates debt terms with required fields', async () => {
      const portfolioItem = {
        id: 42,
        tenantId: 'test-tenant-123',
        category: { type: 'Debt' },
      };
      mockPrisma.portfolioItem.findFirst.mockResolvedValueOnce(portfolioItem);

      const createdRecord = {
        id: 1,
        assetId: 42,
        initialBalance: new Decimal(250000),
        interestRate: new Decimal(4.5),
        termInMonths: 360,
        originationDate: new Date('2024-01-01'),
      };
      mockPrisma.debtTerms.upsert.mockResolvedValueOnce(createdRecord);

      const req = makeReq({
        method: 'POST',
        query: { assetId: '42' },
        body: {
          initialBalance: 250000,
          interestRate: 4.5,
          termInMonths: 360,
          originationDate: '2024-01-01',
        },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(200);
      expect(res._body).toEqual(createdRecord);
    });

    it('returns 400 for missing required fields', async () => {
      const req = makeReq({
        method: 'POST',
        query: { assetId: '42' },
        body: {
          initialBalance: 250000,
          // missing interestRate, termInMonths, originationDate
        },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(400);
      expect(res._body.error).toContain('Missing required fields');
    });

    it('validates asset is Debt type', async () => {
      const portfolioItem = {
        id: 42,
        tenantId: 'test-tenant-123',
        category: { type: 'Investments' },
      };
      mockPrisma.portfolioItem.findFirst.mockResolvedValueOnce(portfolioItem);

      const req = makeReq({
        method: 'POST',
        query: { assetId: '42' },
        body: {
          initialBalance: 250000,
          interestRate: 4.5,
          termInMonths: 360,
          originationDate: '2024-01-01',
        },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(400);
      expect(res._body.error).toContain('Debt');
    });
  });

  describe('PUT', () => {
    it('updates existing debt terms', async () => {
      const existingDebtTerms = {
        id: 1,
        assetId: 42,
        initialBalance: new Decimal(250000),
        interestRate: new Decimal(4.5),
        termInMonths: 360,
        originationDate: new Date('2024-01-01'),
      };
      mockPrisma.debtTerms.findFirst.mockResolvedValueOnce(existingDebtTerms);

      const updatedRecord = { ...existingDebtTerms, interestRate: new Decimal(3.75) };
      mockPrisma.debtTerms.update.mockResolvedValueOnce(updatedRecord);

      const req = makeReq({
        method: 'PUT',
        query: { assetId: '42' },
        body: { interestRate: 3.75 },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(200);
      expect(res._body.interestRate).toEqual(new Decimal(3.75));
    });

    it('returns 404 when debt terms not found for update', async () => {
      mockPrisma.debtTerms.findFirst.mockResolvedValueOnce(null);

      const req = makeReq({
        method: 'PUT',
        query: { assetId: '42' },
        body: { interestRate: 3.75 },
      });
      const res = makeRes();

      await handler(req as NextApiRequest, res as unknown as NextApiResponse);

      expect(res._status).toBe(404);
    });
  });
});
