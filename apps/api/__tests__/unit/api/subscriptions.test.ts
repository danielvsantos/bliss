/**
 * Handler tests for /api/subscriptions.
 *
 * Mocked-handler pattern: rate limiter / auth / cors / prisma / produceEvent /
 * FX / cooldown are all mocked. Covers the HTTP contract, pagination, the
 * full-set summary, the merge-visibility markers and the POST actions.
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
      count: vi.fn(),
      aggregate: vi.fn(),
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

const { batchFetchRates } = vi.hoisted(() => ({ batchFetchRates: vi.fn() }));
vi.mock('../../../utils/currencyConversion.js', () => ({ batchFetchRates, convertCurrency: vi.fn() }));

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * Wire the GET query fan-out from a single `rows` fixture. `rows` are full
 * detail rows; the handler's lite/identity/detail queries are all served from
 * the same array, routed by the query shape.
 */
function setupGet({
  rows = [] as Row[],
  mergeCandidates = [] as Row[],
  mergedCount = 0,
  lastDetectedAt = null as Date | null,
  portfolioCurrency = 'USD',
}: {
  rows?: Row[];
  mergeCandidates?: Row[];
  mergedCount?: number;
  lastDetectedAt?: Date | null;
  portfolioCurrency?: string;
} = {}) {
  mockPrisma.tenant.findUnique.mockResolvedValue({ portfolioCurrency, subscriptionsFullScanAt: null });
  mockPrisma.recurringCharge.groupBy.mockResolvedValue([]);
  mockPrisma.category.findMany.mockResolvedValue([]);
  mockPrisma.recurringCharge.aggregate.mockResolvedValue({ _max: { lastDetectedAt } });
  mockPrisma.recurringCharge.count.mockImplementation(({ where }: { where: Row }) => {
    // mergedCount query: { mergedIntoHash: { not: null } }
    if (where?.mergedIntoHash && typeof where.mergedIntoHash === 'object') {
      return Promise.resolve(mergedCount);
    }
    return Promise.resolve(0);
  });
  mockPrisma.recurringCharge.findMany.mockImplementation((args: Row) => {
    const where = args?.where ?? {};
    if (where.id?.in) {
      return Promise.resolve(rows.filter((r) => where.id.in.includes(r.id)));
    }
    // identity rows — plain select of descriptionHash/mergedIntoHash/merchantLabel
    if (args?.select?.mergedIntoHash === true && args?.select?.merchantLabel === true && !args?.select?.chargeKey) {
      return Promise.resolve(rows.map((r) => ({
        descriptionHash: r.descriptionHash,
        mergedIntoHash: r.mergedIntoHash ?? null,
        merchantLabel: r.merchantLabel,
      })));
    }
    // merge candidates — has an include.category and the not-dismissed/not-merged where
    if (args?.include?.category && where.state && where.mergedIntoHash === null) {
      return Promise.resolve(mergeCandidates);
    }
    // the lite full-set query (select.chargeKey + orderBy)
    return Promise.resolve(rows);
  });
  // Default FX: 1.1× for anything not the display currency.
  batchFetchRates.mockImplementation((from: string, to: string, dates: string[]) => {
    const m = new Map<string, unknown>();
    for (const d of dates) m.set(d, from === to ? 1 : 1.1);
    return Promise.resolve(m);
  });
}

function detailRow(o: Row): Row {
  return {
    id: o.id,
    descriptionHash: o.descriptionHash,
    chargeKey: o.chargeKey ?? o.descriptionHash,
    merchantLabel: o.merchantLabel ?? 'M',
    categoryId: o.categoryId ?? 10,
    category: o.category ?? { id: 10, name: 'Media', icon: '📺', isRecurring: true },
    state: o.state ?? 'DETECTED',
    status: o.status ?? 'ACTIVE',
    cadence: o.cadence ?? 'MONTHLY',
    userCadenceLocked: o.userCadenceLocked ?? false,
    userLabelLocked: o.userLabelLocked ?? false,
    detectionReason: o.detectionReason ?? 'CATEGORY_SIGNAL',
    amount: o.amount ?? 10,
    currency: o.currency ?? 'USD',
    occurrenceCount: o.occurrenceCount ?? 3,
    firstChargedAt: o.firstChargedAt ?? null,
    lastChargedAt: o.lastChargedAt ?? new Date('2026-09-01T00:00:00Z'),
    nextExpectedAt: o.nextExpectedAt ?? null,
    lastDetectedAt: o.lastDetectedAt ?? new Date('2026-09-02T00:00:00Z'),
    updatedAt: o.updatedAt ?? new Date('2026-09-02T00:00:00Z'),
    contributingTransactionIds: o.contributingTransactionIds ?? [],
    mergedIntoHash: o.mergedIntoHash ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRefreshCooldownRemaining.mockResolvedValue(0);
});

describe('GET /api/subscriptions', () => {
  it('computes the monthly + annual summary over the full filtered set with parallel FX', async () => {
    setupGet({
      rows: [
        detailRow({ id: 1, descriptionHash: 'h1', merchantLabel: 'Netflix', cadence: 'MONTHLY', amount: 10, currency: 'USD' }),
        detailRow({ id: 2, descriptionHash: 'h2', merchantLabel: 'Spotify', cadence: 'ANNUAL', amount: 120, currency: 'EUR' }),
      ],
    });

    const req = makeReq({ query: { view: 'active' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    // Netflix 10/mo + Spotify (120 × 1.1)/12 = 10 + 11 = 21
    expect(res._body.summary.monthlyTotal).toBeCloseTo(21, 5);
    expect(res._body.summary.annualTotal).toBeCloseTo(252, 5);
    expect(res._body.items[1].currency).toBe('EUR');
    expect(res._body.displayCurrency).toBe('USD');
    // one batch call per distinct non-display currency, not one per row
    expect(batchFetchRates).toHaveBeenCalledTimes(1);
    expect(batchFetchRates).toHaveBeenCalledWith('EUR', 'USD', expect.any(Array));
  });

  it('flags fx-unavailable rows and excludes them from the total', async () => {
    setupGet({
      rows: [detailRow({ id: 3, descriptionHash: 'h3', merchantLabel: 'X', category: null, amount: 9, currency: 'JPY' })],
    });
    batchFetchRates.mockImplementation((_from: string, _to: string, dates: string[]) => {
      const m = new Map<string, unknown>();
      for (const d of dates) m.set(d, null); // no rate
      return Promise.resolve(m);
    });

    const req = makeReq({ query: {} });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._body.summary.monthlyTotal).toBe(0);
    expect(res._body.summary.fxUnavailableCount).toBe(1);
    expect(res._body.items[0].fxUnavailable).toBe(true);
  });

  it('scopes the query by tenantId and passes the categoryId filter', async () => {
    setupGet();
    const req = makeReq({ query: { view: 'lapsed', categoryId: '42' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    const liteCall = mockPrisma.recurringCharge.findMany.mock.calls.find(
      ([a]) => a?.select?.chargeKey === true && a?.orderBy,
    );
    const where = liteCall![0].where;
    expect(where.tenantId).toBe('tenant-A');
    expect(where.categoryId).toBe(42);
    expect(where.status).toBe('LAPSED');
  });

  it('hides merge tombstones from the active/lapsed views', async () => {
    setupGet();
    const req = makeReq({ query: { view: 'active' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    const liteCall = mockPrisma.recurringCharge.findMany.mock.calls.find(
      ([a]) => a?.select?.chargeKey === true && a?.orderBy,
    );
    expect(liteCall![0].where.mergedIntoHash).toBeNull();
    expect(liteCall![0].where.state).toEqual({ not: 'DISMISSED' });
  });

  it('reports summary.mergedCount', async () => {
    setupGet({ mergedCount: 3 });
    const req = makeReq({ query: { view: 'active' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    expect(res._body.summary.mergedCount).toBe(3);
  });

  it('paginates: 60 rows, limit 25 → 25 items, total 60, totalPages 3, summary over all 60', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      detailRow({ id: i + 1, descriptionHash: `h${i + 1}`, amount: 10, currency: 'USD', cadence: 'MONTHLY' }),
    );
    setupGet({ rows });

    const req = makeReq({ query: { view: 'active', page: '1', limit: '25' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body.items).toHaveLength(25);
    expect(res._body.total).toBe(60);
    expect(res._body.totalPages).toBe(3);
    expect(res._body.page).toBe(1);
    expect(res._body.limit).toBe(25);
    // 60 × 10/mo, all counted even though only 25 are on the page
    expect(res._body.summary.monthlyTotal).toBeCloseTo(600, 5);
  });

  it('page 2 returns the next slice in the defined order', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      detailRow({ id: i + 1, descriptionHash: `h${i + 1}` }),
    );
    setupGet({ rows });

    const req = makeReq({ query: { page: '2', limit: '25' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._body.items.map((it: Row) => it.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 26),
    );
  });

  it('rejects a non-numeric page / limit', async () => {
    setupGet();
    for (const q of [{ page: 'abc' }, { limit: 'xyz' }]) {
      const req = makeReq({ query: q });
      const res = makeRes();
      await handler(req as NextApiRequest, res as unknown as NextApiResponse);
      expect(res._status).toBe(400);
    }
  });

  it('flags a stale merge target and logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lastDetectedAt = new Date('2026-09-05T00:00:00Z');
    setupGet({
      lastDetectedAt,
      rows: [
        // target row — updatedAt predates the tenant's last detection run
        detailRow({ id: 1, descriptionHash: 'tgt', updatedAt: new Date('2026-09-01T00:00:00Z') }),
        // a tombstone folded into it
        detailRow({ id: 2, descriptionHash: 'src', mergedIntoHash: 'tgt', state: 'DETECTED' }),
      ],
    });

    const req = makeReq({ query: { view: 'all' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    const target = res._body.items.find((it: Row) => it.descriptionHash === 'tgt');
    expect(target.mergeStale).toBe(true);
    expect(warn).toHaveBeenCalledWith('[subscriptions] stale merge', expect.objectContaining({ targetHash: 'tgt' }));
    warn.mockRestore();
  });

  it('marks a tombstone whose merge target no longer exists', async () => {
    setupGet({
      rows: [
        detailRow({ id: 9, descriptionHash: 'orphan', mergedIntoHash: 'gone-target', state: 'DETECTED' }),
      ],
    });

    const req = makeReq({ query: { view: 'all' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._body.items[0].mergeTargetMissing).toBe(true);
  });

  it('surfaces merge tombstones under "all" with the target label, excluded from counts', async () => {
    setupGet({
      rows: [
        detailRow({ id: 1, descriptionHash: 'tgt', merchantLabel: 'Orange', amount: 30, currency: 'USD' }),
        detailRow({
          id: 5, descriptionHash: 'src', merchantLabel: 'To Orange Espagne S.a.',
          amount: 30, currency: 'USD', mergedIntoHash: 'tgt', state: 'DETECTED',
        }),
      ],
    });

    const req = makeReq({ query: { view: 'all' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const src = res._body.items.find((it: Row) => it.descriptionHash === 'src');
    expect(src.mergedIntoHash).toBe('tgt');
    expect(src.mergedIntoLabel).toBe('Orange');
    // the tombstone does not count toward the active total (only the target does)
    expect(res._body.summary.activeCount).toBe(1);
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

  it('confirm { transactionId } seeds a provisional row stamped with a chargeKey', async () => {
    mockPrisma.transaction.findFirst.mockResolvedValue({
      id: 7, description: 'GYM', categoryId: 20, debit: 30, currency: 'USD', transaction_date: new Date(),
    });
    mockPrisma.recurringCharge.findUnique.mockResolvedValue(null);
    mockPrisma.recurringCharge.upsert.mockResolvedValue({ id: 99, amount: 30 });
    const req = makeReq({ method: 'POST', body: { action: 'confirm', transactionId: 7 } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(201);
    const create = mockPrisma.recurringCharge.upsert.mock.calls[0][0].create;
    expect(create.chargeKey).toBe(create.descriptionHash);
  });

  it('dismiss updates the row to DISMISSED', async () => {
    mockPrisma.recurringCharge.count.mockResolvedValue(0);
    mockPrisma.recurringCharge.updateMany.mockResolvedValue({ count: 1 });
    const req = makeReq({ method: 'POST', body: { action: 'dismiss', descriptionHash: 'h1' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    expect(mockPrisma.recurringCharge.updateMany.mock.calls[0][0].data.state).toBe('DISMISSED');
  });

  it('dismiss of a merge target is blocked with 409 MERGE_TARGET_HAS_DEPENDENTS', async () => {
    mockPrisma.recurringCharge.count.mockResolvedValue(2); // dependents exist
    const req = makeReq({ method: 'POST', body: { action: 'dismiss', descriptionHash: 'tgt' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(409);
    expect(res._body.code).toBe('MERGE_TARGET_HAS_DEPENDENTS');
    expect(mockPrisma.recurringCharge.updateMany).not.toHaveBeenCalled();
  });

  it('dismiss returns 404 when nothing matched', async () => {
    mockPrisma.recurringCharge.count.mockResolvedValue(0);
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
    const lastChargedAt = new Date(Date.now() - 40 * 86_400_000);
    mockPrisma.recurringCharge.findUnique.mockResolvedValue({ lastChargedAt, status: 'ACTIVE' });
    mockPrisma.recurringCharge.update.mockResolvedValue({ id: 1, cadence: 'WEEKLY', status: 'LAPSED', amount: 5 });
    const req = makeReq({ method: 'POST', body: { action: 'setCadence', descriptionHash: 'h1', cadence: 'WEEKLY' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
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
    getRefreshCooldownRemaining.mockResolvedValue(600);
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

  it('rename sets a custom label and locks it against the detector', async () => {
    mockPrisma.recurringCharge.findUnique.mockResolvedValue({ id: 1 });
    mockPrisma.recurringCharge.update.mockResolvedValue({ id: 1, merchantLabel: 'Netflix Family', amount: 5 });
    const req = makeReq({ method: 'POST', body: { action: 'rename', descriptionHash: 'h1', merchantLabel: '  Netflix Family  ' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    const data = mockPrisma.recurringCharge.update.mock.calls[0][0].data;
    expect(data.merchantLabel).toBe('Netflix Family');
    expect(data.userLabelLocked).toBe(true);
  });

  it('rename rejects an empty label', async () => {
    const req = makeReq({ method: 'POST', body: { action: 'rename', descriptionHash: 'h1', merchantLabel: '   ' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(400);
  });

  it('rename returns 404 for an unknown descriptionHash', async () => {
    mockPrisma.recurringCharge.findUnique.mockResolvedValue(null);
    const req = makeReq({ method: 'POST', body: { action: 'rename', descriptionHash: 'nope', merchantLabel: 'X' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(404);
  });

  it('merge repoints the alias + chargeKey at the target row and rescans', async () => {
    mockPrisma.recurringCharge.findUnique
      .mockResolvedValueOnce({ id: 1, descriptionHash: 'src', merchantLabel: 'To Orange Espagne S.a.', mergedIntoHash: null })
      .mockResolvedValueOnce({ id: 2, descriptionHash: 'tgt', chargeKey: 'tgt', merchantLabel: 'My Phone Plan', mergedIntoHash: null });
    mockPrisma.recurringCharge.update.mockResolvedValue({ id: 1 });
    const req = makeReq({
      method: 'POST',
      body: { action: 'merge', sourceDescriptionHash: 'src', targetDescriptionHash: 'tgt' },
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    const data = mockPrisma.recurringCharge.update.mock.calls[0][0].data;
    expect(data.mergedIntoHash).toBe('tgt');
    expect(data.chargeKey).toBe('tgt');
    expect(data.nextExpectedAt).toBeNull();
    expect(data.contributingTransactionIds).toEqual([]);
    expect(res._body.mergedIntoHash).toBe('tgt');
    expect(produceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SUBSCRIPTION_DETECTION_REQUESTED', source: 'merge', mode: 'incremental' }),
    );
  });

  it('merge falls back to the target descriptionHash when it has no chargeKey', async () => {
    mockPrisma.recurringCharge.findUnique
      .mockResolvedValueOnce({ id: 1, descriptionHash: 'src', merchantLabel: 'A', mergedIntoHash: null })
      .mockResolvedValueOnce({ id: 2, descriptionHash: 'tgt', merchantLabel: 'B', mergedIntoHash: null });
    mockPrisma.recurringCharge.update.mockResolvedValue({ id: 1 });
    const req = makeReq({
      method: 'POST',
      body: { action: 'merge', sourceDescriptionHash: 'src', targetDescriptionHash: 'tgt' },
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(mockPrisma.recurringCharge.update.mock.calls[0][0].data.chargeKey).toBe('tgt');
  });

  it('merge rejects merging a row into itself', async () => {
    const req = makeReq({
      method: 'POST',
      body: { action: 'merge', sourceDescriptionHash: 'x', targetDescriptionHash: 'x' },
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(400);
  });

  it('merge rejects a source that is already merged', async () => {
    mockPrisma.recurringCharge.findUnique
      .mockResolvedValueOnce({ id: 1, descriptionHash: 'src', merchantLabel: 'A', mergedIntoHash: 'somewhere' })
      .mockResolvedValueOnce({ id: 2, descriptionHash: 'tgt', merchantLabel: 'B', mergedIntoHash: null });
    const req = makeReq({
      method: 'POST',
      body: { action: 'merge', sourceDescriptionHash: 'src', targetDescriptionHash: 'tgt' },
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(400);
    expect(mockPrisma.recurringCharge.update).not.toHaveBeenCalled();
  });

  it('merge returns 404 when the target row does not exist', async () => {
    mockPrisma.recurringCharge.findUnique
      .mockResolvedValueOnce({ id: 1, descriptionHash: 'src', merchantLabel: 'A', mergedIntoHash: null })
      .mockResolvedValueOnce(null);
    const req = makeReq({
      method: 'POST',
      body: { action: 'merge', sourceDescriptionHash: 'src', targetDescriptionHash: 'tgt' },
    });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(404);
  });

  it('unmerge clears mergedIntoHash and rescans', async () => {
    mockPrisma.recurringCharge.updateMany.mockResolvedValue({ count: 1 });
    const req = makeReq({ method: 'POST', body: { action: 'unmerge', descriptionHash: 'src' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(200);
    const call = mockPrisma.recurringCharge.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId: 'tenant-A', descriptionHash: 'src', mergedIntoHash: { not: null } });
    expect(call.data).toEqual({ mergedIntoHash: null });
    expect(produceEvent).toHaveBeenCalledWith(expect.objectContaining({ source: 'unmerge' }));
  });

  it('unmerge returns 404 when the row is not merged', async () => {
    mockPrisma.recurringCharge.updateMany.mockResolvedValue({ count: 0 });
    const req = makeReq({ method: 'POST', body: { action: 'unmerge', descriptionHash: 'src' } });
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);
    expect(res._status).toBe(404);
  });
});
