/**
 * Unit tests for GET/PUT /api/onboarding/progress
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ---------------------------------------------------------------------------
// Mocks — must come before handler import
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenant: { findUnique: vi.fn(), update: vi.fn() },
    account: { count: vi.fn() },
    transaction: { findFirst: vi.fn() },
  },
}));

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 1, tenantId: 'tenant-1', role: 'admin', email: 'a@test.com' };

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

import handler from '../../../pages/api/onboarding/progress.js';

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

describe('GET /api/onboarding/progress', () => {
  it('returns 405 for unsupported methods', async () => {
    const req = makeReq({ method: 'DELETE' });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['GET', 'PUT']);
  });

  it('returns onboarding progress steps', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({
      onboardingProgress: {
        checklist: {
          connectBank: { done: false, skipped: false },
          reviewTransactions: { done: false },
          exploreExpenses: { done: false },
          checkPnL: { done: false },
        },
        setupFlow: {},
      },
      onboardingCompletedAt: null,
    });
    mockPrisma.account.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.findFirst.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.onboardingProgress).toBeDefined();
    expect(res._body.onboardingProgress.checklist.connectBank.done).toBe(false);
    expect(res._body.onboardingCompletedAt).toBeNull();
  });

  it('auto-corrects connectBank when accounts exist', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({
      onboardingProgress: {
        checklist: {
          connectBank: { done: false, skipped: false },
          reviewTransactions: { done: false },
          exploreExpenses: { done: false },
          checkPnL: { done: false },
        },
        setupFlow: {},
      },
      onboardingCompletedAt: null,
    });
    // Account exists
    mockPrisma.account.count.mockResolvedValueOnce(2);
    // Transaction exists
    mockPrisma.transaction.findFirst.mockResolvedValueOnce({ id: 1 });

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.onboardingProgress.checklist.connectBank.done).toBe(true);
    expect(res._body.onboardingProgress.checklist.reviewTransactions.done).toBe(true);
  });

  it('returns 404 when tenant not found', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);
    mockPrisma.account.count.mockResolvedValueOnce(0);
    mockPrisma.transaction.findFirst.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: 'Tenant not found' });
  });

  it('strips deprecated setPortfolioCurrency from legacy data', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({
      onboardingProgress: {
        checklist: {
          connectBank: { done: true },
          reviewTransactions: { done: false },
          exploreExpenses: { done: false },
          checkPnL: { done: false },
          setPortfolioCurrency: { done: true },
        },
        setupFlow: {},
      },
      onboardingCompletedAt: null,
    });
    mockPrisma.account.count.mockResolvedValueOnce(1);
    mockPrisma.transaction.findFirst.mockResolvedValueOnce(null);

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.onboardingProgress.checklist.setPortfolioCurrency).toBeUndefined();
  });
});

describe('PUT /api/onboarding/progress', () => {
  it('marks a checklist step as done', async () => {
    mockPrisma.tenant.findUnique.mockResolvedValueOnce({
      onboardingProgress: {
        checklist: {
          connectBank: { done: false, skipped: false },
          reviewTransactions: { done: false },
          exploreExpenses: { done: false },
          checkPnL: { done: false },
        },
        setupFlow: {},
      },
      onboardingCompletedAt: null,
    });
    mockPrisma.tenant.update.mockResolvedValueOnce({
      onboardingProgress: {
        checklist: {
          connectBank: { done: false, skipped: false },
          reviewTransactions: { done: false },
          exploreExpenses: { done: true },
          checkPnL: { done: false },
        },
        setupFlow: {},
      },
      onboardingCompletedAt: null,
    });

    const req = makeReq({ method: 'PUT', body: { step: 'exploreExpenses' } });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(mockPrisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
      }),
    );
  });

  it('returns 400 without step', async () => {
    const req = makeReq({ method: 'PUT', body: {} });
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(400);
    expect(res._body.error).toContain('step is required');
  });
});
