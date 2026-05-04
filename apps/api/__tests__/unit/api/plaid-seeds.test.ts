/**
 * Unit tests for GET /api/plaid/transactions/seeds
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

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidItem: { findFirst: vi.fn() },
    plaidTransaction: { findMany: vi.fn() },
    category: { findMany: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/plaid/transactions/seeds.js';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return { method: 'GET', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
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

describe('GET /api/plaid/transactions/seeds', () => {
  it('returns 400 when plaidItemId is missing', async () => {
    const req = makeReq({ query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/plaidItemId is required/i);
  });

  it('returns 404 when plaid item not found', async () => {
    mockPrisma.plaidItem.findFirst.mockResolvedValue(null);

    const req = makeReq({ query: { plaidItemId: 'pi-x' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns empty array when no seed-held transactions', async () => {
    mockPrisma.plaidItem.findFirst.mockResolvedValue({ id: 'pi-1' });
    mockPrisma.plaidTransaction.findMany.mockResolvedValue([]);

    const req = makeReq({ query: { plaidItemId: 'pi-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual([]);
  });

  it('returns grouped seeds by frequency', async () => {
    mockPrisma.plaidItem.findFirst.mockResolvedValue({ id: 'pi-1' });
    mockPrisma.plaidTransaction.findMany.mockResolvedValue([
      { id: 'tx-1', name: 'Starbucks', merchantName: 'Starbucks', suggestedCategoryId: 5, aiConfidence: 0.85, classificationSource: 'LLM', classificationReasoning: null, category: null },
      { id: 'tx-2', name: 'Starbucks', merchantName: 'Starbucks', suggestedCategoryId: 5, aiConfidence: 0.85, classificationSource: 'LLM', classificationReasoning: null, category: null },
      { id: 'tx-3', name: 'Amazon', merchantName: 'Amazon', suggestedCategoryId: 6, aiConfidence: 0.90, classificationSource: 'LLM', classificationReasoning: null, category: null },
    ]);
    mockPrisma.category.findMany.mockResolvedValue([
      { id: 5, name: 'Food', group: 'Daily', type: 'Essentials' },
      { id: 6, name: 'Shopping', group: 'Lifestyle', type: 'Lifestyle' },
    ]);

    const req = makeReq({ query: { plaidItemId: 'pi-1', limit: '10' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toHaveLength(2);
    expect(res._body[0].description).toBe('Starbucks');
    expect(res._body[0].count).toBe(2);
  });

  it('returns 405 for POST', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
