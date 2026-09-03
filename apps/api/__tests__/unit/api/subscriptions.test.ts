/**
 * Handler tests for /api/subscriptions.
 *
 * Mocked-handler pattern: rate limiter / auth / cors / prisma / produceEvent /
 * currency conversion / cooldown are all mocked. Focuses on the HTTP contract,
 * summary math, filter plumbing and the 6 POST actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

const mockUser = { id: 'u1', tenantId: 'tenant-A', role: 'admin', email: 'a@test.com' };
vi.mock('../../../utils/withAuth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withAuth: (handler: any) => async (req: any, res: any) => {
    req.user = { ...mockUser };
    return handler(req, res);
  },
}));

vi.mock('../../../utils/cors.js', () => ({ cors: () => false }));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), init: vi.fn() }));

vi.mock('@prisma/client/runtime/library', () => ({
  Decimal: class MockDecimal {
    value: number;
    constructor(v: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.value = typeof v === 'object' && v !== null ? (v as any).value : Number(v);
    }
    plus(o: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new MockDecimal(this.value + ((o as any)?.value ?? Number(o)));
    }
    times(o: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new MockDecimal(this.value * ((o as any)?.value ?? Number(o)));
    }
    toNumber() {
      return this.value;
    }
    valueOf() {
      return this.value;
    }
  },
}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tenant: { findUnique: vi.fn(), update: vi.fn() },
    recurringCharge: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    category: { findMany: vi.fn() },
    transaction: { findFirst: vi.fn() },
  },
}));
vi.mock('../../../prisma/prisma.js', () => ({ default: mockPrisma }));

const { convertCurrency } = vi.hoisted(() => ({ convertCurrency: vi.fn() }));
vi.mock('../../../utils/currencyConversion.js', () => ({ convertCurrency }));

const { produceEvent } = vi.hoisted(() => ({ produceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../utils/produceEvent.js', () => ({ produceEvent }));

const { getRefreshCooldownRemaining, armRefreshCooldown } = vi.hoisted(() => ({
  getRefreshCooldownRemaining: vi.fn().mockResolvedValue(0),
  armRefreshCooldown: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../utils/subscriptionCooldown.js', () => ({ getRefreshCooldownRemaining, armRefreshCooldown }));

import handler from '../../../pages/api/subscriptions.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReq(overrides: Record<string, any> = {}): NextApiRequest {
  return { method: 'GET', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as unknown as NextApiRequest;
}
function makeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {};
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.tenant.findUnique.mockResolvedValue({ portfolioCurrency: 'USD', subscriptionsFullScanAt: null });
  mockPrisma.recurringCharge.groupBy.mockResolvedValue([]);
  mockPrisma.category.findMany.mockResolvedValue([]);
  getRefreshCooldownRemaining.mockResolvedValue(0);
});

describe('GET /api/subscriptions', () => {
  it('computes the monthly + annual summary with FX conversion', async () => {
    mockPrisma.recurringCharge.findMany.mockResolvedValue([
      {
        id: 1, descriptionHash: 'h1', merchantLabel: 'Netflix', categoryId: 10,
        category: { id: 10, name: 'Media', icon: '📺' },
        state: 'DETECTED', cadence: 'MONTHLY', userCadenceLocked: false, status: 'ACTIVE',
        detectionReason: 'CATEGORY_SIGNAL', amount: 10, currency: 'USD',
        occurrenceCount: 3, firstChargedAt: null, lastChargedAt: new Date(), nextExpectedAt: null,
        lastDetectedAt: new Date(), contributingTransactionIds: [],
      },
      {
        id: 2, descriptionHash: 'h2', merchantLabel: 'Spotify', categoryId: 10,
        category: { id: 10, name: 'Media', icon: '📺' },
        state: 'DETECTED', cadence: 'ANNUAL', userCadenceLocked: false, status: 'ACTIVE',
        detectionReason: 'CATEGORY_SIGNAL', amount: 120, currency: 'EUR',
        occurrenceCount: 2, firstChargedAt: null, lastChargedAt: new Date(), nextExpectedAt: null,
        lastDetectedAt: new Date(), contributingTransactionIds: [],
      },
    ]);
    // USD stays; EUR 120 → 132 USD
    convertCurrency.mockImplementation((amt: unknown, from: string) =>
      Promise.resolve(from === 'USD' ? { value: Number(amt) } : { value: Number(amt) * 1.1 }),
    );

    const req = makeReq({ query: { view: 'active' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    // Netflix 10/mo + Spotify 132/12 = 10 + 11 = 21
    expect(res._body.summary.monthlyTotal).toBeCloseTo(21, 5);
    expect(res._body.summary.annualTotal).toBeCloseTo(252, 5);
    expect(res._body.items[1].currency).toBe('EUR'); // native currency preserved
    expect(res._body.displayCurrency).toBe('USD');
  });

  it('flags fx-unavailable rows and excludes them from the total', async () => {
    mockPrisma.recurringCharge.findMany.mockResolvedValue([
      {
        id: 3, descriptionHash: 'h3', merchantLabel: 'X', categoryId: 10, category: null,
        state: 'DETECTED', cadence: 'MONTHLY', userCadenceLocked: false, status: 'ACTIVE',
        detectionReason: 'CATEGORY_SIGNAL', amount: 9, currency: 'JPY',
        occurrenceCount: 3, firstChargedAt: null, lastChargedAt: new Date(), nextExpectedAt: null,
        lastDetectedAt: new Date(), contributingTransactionIds: [],
      },
    ]);
    convertCurrency.mockResolvedValue(null);

    const req = makeReq({ query: {} });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._body.summary.monthlyTotal).toBe(0);
    expect(res._body.summary.fxUnavailableCount).toBe(1);
    expect(res._body.items[0].fxUnavailable).toBe(true);
  });

  it('scopes the query by tenantId and passes the categoryId filter', async () => {
    mockPrisma.recurringCharge.findMany.mockResolvedValue([]);
    const req = makeReq({ query: { view: 'lapsed', categoryId: '42' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    const where = mockPrisma.recurringCharge.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe('tenant-A');
    expect(where.categoryId).toBe(42);
    expect(where.status).toBe('LAPSED');
  });
});

describe('POST /api/subscriptions actions', () => {
  it('confirm { descriptionHash } flips state to CONFIRMED', async () => {
    mockPrisma.recurringCharge.updateMany.mockResolvedValue({ count: 1 });
    const req = makeReq({ method: 'POST', body: { action: 'confirm', descriptionHash: 'h1' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    expect(mockPrisma.recurringCharge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-A', descriptionHash: 'h1' }, data: expect.objectContaining({ state: 'CONFIRMED' }) }),
    );
  });

  it('confirm { transactionId } seeds a provisional row', async () => {
    mockPrisma.transaction.findFirst.mockResolvedValue({
      id: 7, description: 'GYM', categoryId: 20, debit: 30, currency: 'USD', transaction_date: new Date(),
    });
    mockPrisma.recurringCharge.findUnique.mockResolvedValue(null);
    mockPrisma.recurringCharge.upsert.mockResolvedValue({ id: 99, amount: 30 });
    const req = makeReq({ method: 'POST', body: { action: 'confirm', transactionId: 7 } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(201);
    expect(mockPrisma.recurringCharge.upsert).toHaveBeenCalled();
  });

  it('dismiss updates the row to DISMISSED', async () => {
    mockPrisma.recurringCharge.updateMany.mockResolvedValue({ count: 1 });
    const req = makeReq({ method: 'POST', body: { action: 'dismiss', descriptionHash: 'h1' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    expect(mockPrisma.recurringCharge.updateMany.mock.calls[0][0].data.state).toBe('DISMISSED');
  });

  it('dismiss returns 404 when nothing matched', async () => {
    mockPrisma.recurringCharge.updateMany.mockResolvedValue({ count: 0 });
    const req = makeReq({ method: 'POST', body: { action: 'dismiss', descriptionHash: 'nope' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(404);
  });

  it('restore deletes the DISMISSED tombstone', async () => {
    mockPrisma.recurringCharge.deleteMany.mockResolvedValue({ count: 1 });
    const req = makeReq({ method: 'POST', body: { action: 'restore', descriptionHash: 'h1' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    expect(mockPrisma.recurringCharge.deleteMany.mock.calls[0][0].where.state).toBe('DISMISSED');
  });

  it('setCadence validates the cadence enum', async () => {
    const req = makeReq({ method: 'POST', body: { action: 'setCadence', descriptionHash: 'h1', cadence: 'HOURLY' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(400);
  });

  it('setCadence locks the cadence and recomputes nextExpectedAt', async () => {
    mockPrisma.recurringCharge.findUnique.mockResolvedValue({ lastChargedAt: new Date('2026-08-01T00:00:00Z') });
    mockPrisma.recurringCharge.update.mockResolvedValue({ id: 1, cadence: 'QUARTERLY', amount: 5 });
    const req = makeReq({ method: 'POST', body: { action: 'setCadence', descriptionHash: 'h1', cadence: 'QUARTERLY' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    const data = mockPrisma.recurringCharge.update.mock.calls[0][0].data;
    expect(data.userCadenceLocked).toBe(true);
    expect(data.nextExpectedAt).toBeInstanceOf(Date);
  });

  it('setCadence un-lapses a row when the new cadence makes it current again', async () => {
    // Last charge ~7 months ago: LAPSED as MONTHLY (grace 45d), ACTIVE as ANNUAL (grace 547d).
    const lastChargedAt = new Date(Date.now() - 210 * 86_400_000);
    mockPrisma.recurringCharge.findUnique.mockResolvedValue({ lastChargedAt, status: 'LAPSED' });
    mockPrisma.recurringCharge.update.mockResolvedValue({ id: 1, cadence: 'ANNUAL', status: 'ACTIVE', amount: 99 });
    const req = makeReq({ method: 'POST', body: { action: 'setCadence', descriptionHash: 'h1', cadence: 'ANNUAL' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    expect(mockPrisma.recurringCharge.update.mock.calls[0][0].data.status).toBe('ACTIVE');
  });

  it('setCadence lapses a row when the new cadence makes it overdue', async () => {
    // Last charge ~50 days ago: ACTIVE as MONTHLY (grace 45d? no — 50>45 → LAPSED)… use 40d.
    const lastChargedAt = new Date(Date.now() - 40 * 86_400_000);
    mockPrisma.recurringCharge.findUnique.mockResolvedValue({ lastChargedAt, status: 'ACTIVE' });
    mockPrisma.recurringCharge.update.mockResolvedValue({ id: 1, cadence: 'WEEKLY', status: 'LAPSED', amount: 5 });
    const req = makeReq({ method: 'POST', body: { action: 'setCadence', descriptionHash: 'h1', cadence: 'WEEKLY' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    // 40 days > 7 × 1.5 = 10.5 days → LAPSED
    expect(mockPrisma.recurringCharge.update.mock.calls[0][0].data.status).toBe('LAPSED');
  });

  it('refresh enqueues an incremental scan and arms the cooldown', async () => {
    const req = makeReq({ method: 'POST', body: { action: 'refresh' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(202);
    expect(armRefreshCooldown).toHaveBeenCalledWith('tenant-A');
    expect(produceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SUBSCRIPTION_DETECTION_REQUESTED', tenantId: 'tenant-A', mode: 'incremental' }),
    );
  });

  it('refresh returns 429 while the cooldown is active', async () => {
    getRefreshCooldownRemaining.mockResolvedValue(600);
    const req = makeReq({ method: 'POST', body: { action: 'refresh' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(429);
    expect(res._body.retryAfter).toBe(600);
    expect(produceEvent).not.toHaveBeenCalled();
  });

  it('fullScan enqueues a full scan (no cooldown)', async () => {
    getRefreshCooldownRemaining.mockResolvedValue(600); // must not block fullScan
    const req = makeReq({ method: 'POST', body: { action: 'fullScan' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(202);
    expect(produceEvent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full' }));
  });

  it('rejects an unknown action', async () => {
    const req = makeReq({ method: 'POST', body: { action: 'frobnicate' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(400);
  });
});
