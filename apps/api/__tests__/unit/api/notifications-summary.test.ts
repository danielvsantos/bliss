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

// Processing status (#100): the Redis read is mocked; the counting is real.
const { mockReadActivity } = vi.hoisted(() => ({ mockReadActivity: vi.fn() }));
vi.mock('../../../utils/activityStore.js', async () => {
  const actual = await vi.importActual<any>('../../../utils/activityStore.js');
  return { ...actual, readActivity: mockReadActivity };
});

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
  mockReadActivity.mockResolvedValue({ available: false, recent: [] });
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
    mockPrisma.plaidTransaction.count
      .mockResolvedValueOnce(3)  // plaidClassifiedCount
      .mockResolvedValueOnce(0); // plaidFailedCount
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
    // No failed classifications in this scenario
    expect(res._body.signals.find((s: any) => s.type === 'PLAID_CLASSIFICATION_FAILED')).toBeUndefined();
  });

  it('includes a distinct PLAID_CLASSIFICATION_FAILED signal, counted separately from PENDING_REVIEW', async () => {
    mockPrisma.plaidTransaction.count
      .mockResolvedValueOnce(3)  // plaidClassifiedCount
      .mockResolvedValueOnce(2); // plaidFailedCount
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
    const failedSignal = res._body.signals.find((s: any) => s.type === 'PLAID_CLASSIFICATION_FAILED');
    expect(failedSignal).toBeDefined();
    expect(failedSignal.count).toBe(2);
    expect(failedSignal.severity).toBe('warning');
    expect(failedSignal.isNew).toBe(true);
    // PENDING_REVIEW stays scoped to CLASSIFIED-only count (3), not inflated by FAILED (2)
    const reviewSignal = res._body.signals.find((s: any) => s.type === 'PENDING_REVIEW');
    expect(reviewSignal.count).toBe(3);
    // totalUnseen sums both distinct signals: 3 (review) + 2 (failed) = 5
    expect(res._body.totalUnseen).toBe(5);
  });

  it('returns empty counts when no notifications', async () => {
    mockPrisma.plaidTransaction.count
      .mockResolvedValueOnce(0)  // plaidClassifiedCount
      .mockResolvedValueOnce(0); // plaidFailedCount
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
  describe('PROCESSING_FAILED (#100)', () => {
    const emptyPrisma = () => {
      mockPrisma.plaidTransaction.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      mockPrisma.stagedImportRow.count.mockResolvedValueOnce(0);
      mockPrisma.plaidItem.findMany.mockResolvedValueOnce([]);
      mockPrisma.insight.count.mockResolvedValueOnce(0);
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({ onboardingProgress: null, onboardingCompletedAt: new Date() });
      mockPrisma.account.count.mockResolvedValueOnce(0);
      mockPrisma.transaction.findFirst.mockResolvedValueOnce(null);
    };
    const activity = {
      available: true,
      recent: [
        { state: 'failed', finishedAt: '2026-10-04T10:00:00.000Z', errorCode: 'P2034' },
        { state: 'failed', finishedAt: '2026-10-01T10:00:00.000Z', errorCode: 'INTERNAL' },
        { state: 'completed', finishedAt: '2026-10-04T11:00:00.000Z' },
      ],
    };

    it('counts final failures since lastNotificationSeenAt and links admins to Processing', async () => {
      emptyPrisma();
      mockReadActivity.mockResolvedValueOnce(activity);
      const original = mockUser.lastNotificationSeenAt;
      (mockUser as any).lastNotificationSeenAt = new Date('2026-10-03T00:00:00Z');
      const res = makeRes();
      await handler(makeReq() as NextApiRequest, res as unknown as NextApiResponse);
      (mockUser as any).lastNotificationSeenAt = original;

      expect(mockReadActivity).toHaveBeenCalledWith('tenant-1');
      expect(res._body.signals).toEqual([
        expect.objectContaining({ type: 'PROCESSING_FAILED', count: 1, href: '/settings?tab=processing', severity: 'warning', isNew: true }),
      ]);
      expect(res._body.totalUnseen).toBe(1);
    });

    it('gives other roles the label only', async () => {
      emptyPrisma();
      mockReadActivity.mockResolvedValueOnce(activity);
      const original = mockUser.role;
      mockUser.role = 'member';
      const res = makeRes();
      await handler(makeReq() as NextApiRequest, res as unknown as NextApiResponse);
      mockUser.role = original;

      const signal = res._body.signals.find((s: any) => s.type === 'PROCESSING_FAILED');
      expect(signal).toMatchObject({ count: 2, href: null });
    });

    it('adds nothing when status is unavailable', async () => {
      emptyPrisma();
      mockReadActivity.mockResolvedValueOnce({ available: false, recent: [] });
      const res = makeRes();
      await handler(makeReq() as NextApiRequest, res as unknown as NextApiResponse);
      expect(res._body.signals).toEqual([]);
    });
  });
});
