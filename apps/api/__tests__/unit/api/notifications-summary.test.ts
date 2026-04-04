/**
 * Unit tests for GET /api/notifications/summary
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    plaidTransaction: { count: vi.fn() },
    stagedImportRow: { count: vi.fn() },
    plaidItem: { findMany: vi.fn() },
    insight: { count: vi.fn() },
    tenant: { findUnique: vi.fn() },
    account: { count: vi.fn() },
    transaction: { findFirst: vi.fn() },
    user: { update: vi.fn() },
  },
}));

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = {
  id: 1,
  tenantId: 'tenant-1',
  role: 'admin',
  email: 'a@test.com',
  lastNotificationSeenAt: null,
};

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

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import handler from '../../../pages/api/notifications/summary.js';

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

describe('GET /api/notifications/summary', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'DELETE' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PUT']);
  });

  it('returns notification summary counts', async () => {
    mockPrisma.plaidTransaction.count.mockResolvedValueOnce(3);
    mockPrisma.stagedImportRow.count.mockResolvedValueOnce(2);
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([
      { id: 'pi-1', institutionName: 'Chase', status: 'LOGIN_REQUIRED' },
    ]);
    mockPrisma.insight.count.mockResolvedValueOnce(1);
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({
      onboardingProgress: null,
      onboardingCompletedAt: new Date(),
    });
    mockPrisma.account.count.mockResolvedValueOnce(2);
    mockPrisma.transaction.findFirst.mockResolvedValueOnce({ id: 1 });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    // 3 plaid + 2 import = 5 review, plus 1 plaid action, plus 1 insight
    expect(res._body.totalUnseen).toBe(7);
    expect(res._body.signals).toBeDefined();
    expect(res._body.signals.length).toBeGreaterThanOrEqual(2);
    // Check PENDING_REVIEW signal
    const reviewSignal = res._body.signals.find((s: any) => s.type === 'PENDING_REVIEW');
    expect(reviewSignal).toBeDefined();
    expect(reviewSignal.count).toBe(5);
    // Check PLAID_ACTION_REQUIRED signal
    const plaidSignal = res._body.signals.find((s: any) => s.type === 'PLAID_ACTION_REQUIRED');
    expect(plaidSignal).toBeDefined();
  });

  it('returns empty counts when no notifications', async () => {
    mockPrisma.plaidTransaction.count.mockResolvedValueOnce(0);
    mockPrisma.stagedImportRow.count.mockResolvedValueOnce(0);
    mockPrisma.plaidItem.findMany.mockResolvedValueOnce([]);
    mockPrisma.insight.count.mockResolvedValueOnce(0);
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({
      onboardingProgress: null,
      onboardingCompletedAt: new Date(),
    });
    mockPrisma.account.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.findFirst.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.totalUnseen).toBe(0);
    expect(res._body.signals).toEqual([]);
  });
});
