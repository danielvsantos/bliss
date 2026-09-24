/**
 * Unit tests for GET /api/imports/[id] — focused on the eligibleCount query
 * that drives the GroupCard "Approve All (N)" badge.
 *
 * This predicate must stay in sync with bulk-confirm.js's own eligibility
 * filter (see the comment above the query in [id].js) — a mismatch means the
 * badge count and what "Approve All" actually confirms disagree.
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
vi.mock('../../../utils/produceEvent.js', () => ({ produceEvent: vi.fn() }));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stagedImport: { findFirst: vi.fn() },
    stagedImportRow: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      findFirst: vi.fn(),
    },
    category: { findMany: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

import handler from '../../../pages/api/imports/[id].js';

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

describe('GET /api/imports/[id] — eligibleCount predicate', () => {
  it('excludes rows with an unresolved account, mirroring bulk-confirm', async () => {
    mockPrisma.stagedImport.findFirst.mockResolvedValue({
      id: 'import-1',
      status: 'READY',
      fileName: 'march.csv',
    });
    mockPrisma.stagedImportRow.findMany.mockResolvedValue([]);
    mockPrisma.stagedImportRow.count.mockResolvedValue(0);
    mockPrisma.stagedImportRow.findFirst.mockResolvedValue(null);
    // Promise.all order in handleGet: statusCounts, categorySummaryRaw, eligibleCountsRaw
    mockPrisma.stagedImportRow.groupBy
      .mockResolvedValueOnce([]) // statusCounts
      .mockResolvedValueOnce([]) // categorySummaryRaw
      .mockResolvedValueOnce([]); // eligibleCountsRaw

    const req = makeReq({ query: { id: 'import-1' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    // Third groupBy call is the eligibleCountsRaw query
    const eligibleCountsCall = mockPrisma.stagedImportRow.groupBy.mock.calls[2][0];
    expect(eligibleCountsCall.where.accountId).toEqual({ not: null });
    expect(eligibleCountsCall.where.requiresEnrichment).toEqual({ not: true });
    expect(eligibleCountsCall.where.status).toEqual({ in: ['PENDING', 'ERROR', 'STAGED'] });
  });
});
