/**
 * Unit tests for /api/insights
 *
 * Mocked handler pattern: withAuth, cors, rateLimit, Sentry, and Prisma
 * are all mocked so we test handler logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

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
    insight: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

// Mock global fetch for POST (fire-and-forget to backend)
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import handler from '../../../pages/api/insights.js';

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

describe('GET /api/insights', () => {
  it('returns insights with default filters', async () => {
    const insights = [
      { id: 'ins-1', lens: 'spending_velocity', title: 'Spending up', priority: 3, dismissed: false },
    ];
    mockPrisma.insight.findMany.mockResolvedValueOnce(insights);
    mockPrisma.insight.count.mockResolvedValueOnce(1);
    mockPrisma.insight.findFirst.mockResolvedValueOnce({ date: '2026-04-01' });

    const req = makeReq({ method: 'GET', query: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.insights).toEqual(insights);
    expect(res._body.total).toBe(1);
    expect(res._body.latestBatchDate).toBe('2026-04-01');

    // Default filter excludes dismissed
    expect(mockPrisma.insight.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 'test-tenant-123',
        dismissed: false,
      }),
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      skip: 0,
    });
  });

  it('applies lens filter', async () => {
    mockPrisma.insight.findMany.mockResolvedValueOnce([]);
    mockPrisma.insight.count.mockResolvedValueOnce(0);
    mockPrisma.insight.findFirst.mockResolvedValueOnce(null);

    const req = makeReq({ method: 'GET', query: { lens: 'savings_rate' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.insight.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        lens: 'savings_rate',
      }),
      orderBy: expect.any(Array),
      take: 20,
      skip: 0,
    });
  });
});

describe('PUT /api/insights', () => {
  it('updates dismissed status', async () => {
    const insight = { id: 'ins-1', tenantId: 'test-tenant-123', dismissed: false };
    mockPrisma.insight.findFirst.mockResolvedValueOnce(insight);
    mockPrisma.insight.update.mockResolvedValueOnce({ ...insight, dismissed: true });

    const req = makeReq({
      method: 'PUT',
      body: { insightId: 'ins-1', dismissed: true },
    });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.insight.update).toHaveBeenCalledWith({
      where: { id: 'ins-1' },
      data: { dismissed: true },
    });
  });
});

describe('POST /api/insights', () => {
  it('triggers generation and returns 202', async () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(202);
    expect(res._body.message).toBe('Insight generation started');
  });
});

describe('Method validation', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'DELETE' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PUT', 'POST']);
  });
});
