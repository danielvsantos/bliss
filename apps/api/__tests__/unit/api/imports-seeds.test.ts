/**
 * Unit tests for GET /api/imports/[id]/seeds
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
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), init: vi.fn() }));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stagedImport: { findFirst: vi.fn() },
    stagedImportRow: { findMany: vi.fn() },
    category: { findMany: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/imports/[id]/seeds.js';

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

describe('GET /api/imports/[id]/seeds', () => {
  it('returns 404 when import not found', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue(null);

    const req = makeReq({ query: { id: 'import-x' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
  });

  it('returns empty array when no LLM-classified rows', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1' });
    mockPrisma.stagedImportRow.findMany.mockResolvedValue([]);

    const req = makeReq({ query: { id: 'import-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual([]);
  });

  it('returns grouped seeds sorted by frequency', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({ id: 'import-1' });
    mockPrisma.stagedImportRow.findMany.mockResolvedValue([
      { id: 'r-1', description: 'Starbucks', suggestedCategoryId: 5, confidence: 0.85, classificationSource: 'LLM' },
      { id: 'r-2', description: 'Starbucks', suggestedCategoryId: 5, confidence: 0.85, classificationSource: 'LLM' },
      { id: 'r-3', description: 'Amazon', suggestedCategoryId: 6, confidence: 0.90, classificationSource: 'LLM' },
    ]);
    mockPrisma.category.findMany.mockResolvedValue([
      { id: 5, name: 'Food', group: 'Daily', type: 'Essentials' },
      { id: 6, name: 'Shopping', group: 'Lifestyle', type: 'Lifestyle' },
    ]);

    const req = makeReq({ query: { id: 'import-1', limit: '10' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toHaveLength(2);
    expect(res._body[0].description).toBe('Starbucks');
    expect(res._body[0].count).toBe(2);
  });

  it('returns 405 for POST', async () => {
    const req = makeReq({ method: 'POST', query: { id: 'import-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
  });
});
