/**
 * Integration tests — PATCH /api/transactions/bulk (#141).
 *
 * Bulk recategorisation: 1–50 IDs, category only, all-or-nothing, tenant
 * ownership like PUT (#90), classifier feedback per changed row, ONE
 * analytics event per call. Real bliss_test Postgres and the real withAuth;
 * produceEvent and the backend feedback call are mocked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: vi.fn().mockResolvedValue(undefined),
}));

const { fetchWithTimeout } = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../../../utils/fetchWithTimeout.js', () => ({ fetchWithTimeout }));

import bulkHandler from '../../../pages/api/transactions/bulk.js';
import prisma from '../../../prisma/prisma.js';
import { produceEvent } from '../../../utils/produceEvent.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../helpers/tenant.js';
import { ensureReferenceData } from '../../helpers/referenceData.js';
import { bearer, createIntegrationKey, createTenantUser } from '../../helpers/integration.js';

function makeRes() {
  const res: any = { _status: undefined, _body: undefined, statusCode: 200 };
  res.status = vi.fn((code: number) => { res._status = code; res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.setHeader = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

async function patch(body: unknown, auth: Record<string, unknown> = { cookies: { token: tenantA.token } }, method = 'PATCH') {
  const req = { method, url: '/api/transactions/bulk', headers: {}, cookies: {}, query: {}, body, ...auth } as any;
  const res = makeRes();
  await bulkHandler(req, res);
  return res;
}

interface Seeded {
  accountId: number;
  dining: number;
  groceries: number;
  stocks: number;
  loan: number;
}

let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let a: Seeded;
let b: Seeded;

async function seed(tenant: IsolatedTenant, label: string): Promise<Seeded> {
  const ref = await ensureReferenceData();
  const mk = (name: string, group: string, type: string, extra: Record<string, unknown> = {}) =>
    prisma.category.create({ data: { name: `${name} ${label}`, group, type, tenantId: tenant.tenantId, ...extra } });
  const [dining, groceries, stocks, loan] = await Promise.all([
    mk('Restaurants', 'Dining', 'Lifestyle'),
    mk('Supermarket', 'Groceries', 'Essentials'),
    mk('Stocks', 'Stocks', 'Investments', { processingHint: 'API_STOCK', portfolioItemKeyStrategy: 'TICKER' }),
    mk('Car loan', 'Loans', 'Debt'),
  ]);
  const account = await prisma.account.create({
    data: {
      name: `Checking ${label}`, accountNumber: `0000BULK${label}`, bankId: ref.bankId, countryId: ref.countryId,
      currencyCode: ref.currencyCode, tenantId: tenant.tenantId,
    },
  });
  return { accountId: account.id, dining: dining.id, groceries: groceries.id, stocks: stocks.id, loan: loan.id };
}

async function createTxs(tenant: IsolatedTenant, s: Seeded, count: number, categoryId: number, month = 3) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(await prisma.transaction.create({
      data: {
        transaction_date: new Date(Date.UTC(2026, month - 1, 1 + (i % 28))), year: 2026, month, day: 1 + (i % 28), quarter: 'Q1',
        categoryId, accountId: s.accountId, description: `Merchant ${i}`, debit: 10 + i, currency: 'USD',
        tenantId: tenant.tenantId,
      },
    }));
  }
  return rows.map((r) => r.id);
}

const categoriesOf = async (ids: number[]) =>
  (await prisma.transaction.findMany({ where: { id: { in: ids } }, select: { categoryId: true } })).map((r) => r.categoryId);

beforeAll(async () => {
  tenantA = await createIsolatedTenant('bulk-a');
  tenantB = await createIsolatedTenant('bulk-b');
  a = await seed(tenantA, 'A');
  b = await seed(tenantB, 'B');
});

afterAll(async () => {
  await teardownTenant(tenantA.tenantId);
  await teardownTenant(tenantB.tenantId);
});

beforeEach(() => {
  vi.mocked(produceEvent).mockClear();
  fetchWithTimeout.mockReset().mockResolvedValue({ ok: true });
});

describe('PATCH /api/transactions/bulk — success (#141)', () => {
  it('recategorises 50 rows atomically: feedback per row, ONE analytics event', async () => {
    const ids = await createTxs(tenantA, a, 50, a.dining);
    const res = await patch({ ids, categoryId: a.groceries });

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ updated: ids, unchanged: [] });
    expect(await categoriesOf(ids)).toEqual(Array(50).fill(a.groceries));

    // Classifier feedback: one batch call with every changed row.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithTimeout.mock.calls[0];
    expect(url).toMatch(/\/api\/feedback\/batch$/);
    const sent = JSON.parse(init.body);
    expect(sent.tenantId).toBe(tenantA.tenantId);
    expect(sent.entries).toHaveLength(50);
    expect(sent.entries[0]).toEqual({ description: 'Merchant 0', categoryId: a.groceries, transactionId: ids[0] });

    // One event; scopes = old + new slice, no native currency.
    expect(produceEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(produceEvent).mock.calls[0][0] as any;
    expect(event.type).toBe('TAG_ASSIGNMENT_MODIFIED');
    expect(event.tenantId).toBe(tenantA.tenantId);
    expect(event._trigger).toBeUndefined(); // cookie session, not an agent
    expect(event.transactionScopes).toHaveLength(2);
    expect(event.transactionScopes).toEqual(expect.arrayContaining([
      { year: 2026, month: 3, country: 'USA', type: 'Lifestyle', group: 'Dining' },
      { year: 2026, month: 3, country: 'USA', type: 'Essentials', group: 'Groceries' },
    ]));

    // Audit trail: the caller is recorded on the changed rows.
    const row = await prisma.transaction.findUnique({ where: { id: ids[0] } });
    const caller = await prisma.user.findUnique({ where: { id: tenantA.userId } });
    expect(row!.userId).toBe(caller!.email);
  });

  it('reports rows already in the category as unchanged and only writes the rest', async () => {
    const already = await createTxs(tenantA, a, 2, a.groceries, 4);
    const moving = await createTxs(tenantA, a, 3, a.dining, 5);
    const before = await prisma.transaction.findUnique({ where: { id: already[0] } });

    const res = await patch({ ids: [...already, ...moving], categoryId: a.groceries });

    expect(res._status).toBe(200);
    expect(res._body.updated.sort()).toEqual([...moving].sort());
    expect(res._body.unchanged.sort()).toEqual([...already].sort());
    expect(JSON.parse(fetchWithTimeout.mock.calls[0][1].body).entries).toHaveLength(3);
    // Unchanged rows are not touched (no updatedAt churn) and their month
    // (April) is not in the scopes.
    const after = await prisma.transaction.findUnique({ where: { id: already[0] } });
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    const scopes = (vi.mocked(produceEvent).mock.calls[0][0] as any).transactionScopes;
    expect(scopes.map((s: any) => s.month)).toEqual([5, 5]);
  });

  it('every row already in the category: no write, no feedback, no events', async () => {
    const ids = await createTxs(tenantA, a, 3, a.groceries, 6);
    const res = await patch({ ids, categoryId: a.groceries });
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ updated: [], unchanged: ids });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(produceEvent).not.toHaveBeenCalled();
  });

  it('150 rows take 3 calls of 50', async () => {
    const ids = await createTxs(tenantA, a, 150, a.dining, 7);
    for (let i = 0; i < 150; i += 50) {
      const res = await patch({ ids: ids.slice(i, i + 50), categoryId: a.groceries });
      expect(res._status).toBe(200);
      expect(res._body.updated).toHaveLength(50);
    }
    expect(await categoriesOf(ids)).toEqual(Array(150).fill(a.groceries));
    expect(produceEvent).toHaveBeenCalledTimes(3);
  });
});

describe('PATCH /api/transactions/bulk — refusals write nothing (#141)', () => {
  it('an ID from another tenant → 404 naming only the requested ID, nothing written', async () => {
    const own = await createTxs(tenantA, a, 2, a.dining, 8);
    const [foreign] = await createTxs(tenantB, b, 1, b.dining, 8);

    const res = await patch({ ids: [...own, foreign], categoryId: a.groceries });

    expect(res._status).toBe(404);
    expect(res._body).toEqual({
      error: `Transactions not found in this tenant: ${foreign}`,
      code: 'TRANSACTIONS_NOT_FOUND',
      ids: [foreign],
    });
    expect(JSON.stringify(res._body)).not.toMatch(/Merchant|Restaurants B/);
    expect(await categoriesOf(own)).toEqual([a.dining, a.dining]);
    expect(await categoriesOf([foreign])).toEqual([b.dining]);
    expect(produceEvent).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('a non-existent ID gets the same 404', async () => {
    const own = await createTxs(tenantA, a, 1, a.dining, 8);
    const res = await patch({ ids: [...own, 2147483000], categoryId: a.groceries });
    expect(res._status).toBe(404);
    expect(res._body.code).toBe('TRANSACTIONS_NOT_FOUND');
    expect(res._body.ids).toEqual([2147483000]);
  });

  it('a category from another tenant → 400, nothing written', async () => {
    const own = await createTxs(tenantA, a, 1, a.dining, 8);
    const res = await patch({ ids: own, categoryId: b.groceries });
    expect(res._status).toBe(400);
    expect(res._body.error).toBe('Category not found in this tenant.');
    expect(await categoriesOf(own)).toEqual([a.dining]);
  });

  it.each(['stocks', 'loan'] as const)('a %s (Investments / Debt) target category → 400', async (key) => {
    const own = await createTxs(tenantA, a, 1, a.dining, 8);
    const res = await patch({ ids: own, categoryId: a[key] });
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('CATEGORY_NOT_ALLOWED');
    expect(await categoriesOf(own)).toEqual([a.dining]);
  });

  it('rows currently in Investments / Debt → 400 naming them, nothing written', async () => {
    const plain = await createTxs(tenantA, a, 1, a.dining, 9);
    const [inStocks] = await createTxs(tenantA, a, 1, a.stocks, 9);
    const [inLoan] = await createTxs(tenantA, a, 1, a.loan, 9);

    const res = await patch({ ids: [...plain, inStocks, inLoan], categoryId: a.groceries });

    expect(res._status).toBe(400);
    expect(res._body.code).toBe('ROWS_NOT_ALLOWED');
    expect(res._body.ids.sort()).toEqual([inStocks, inLoan].sort());
    expect(res._body.error).toContain(String(inStocks));
    expect(await categoriesOf(plain)).toEqual([a.dining]);
  });

  it.each([
    ['51 IDs', { ids: Array.from({ length: 51 }, (_, i) => i + 1), categoryId: 1 }],
    ['duplicate IDs', { ids: [5, 5], categoryId: 1 }],
    ['an empty list', { ids: [], categoryId: 1 }],
    ['non-integer IDs', { ids: ['7'], categoryId: 1 }],
    ['a missing categoryId', { ids: [7] }],
    ['a string categoryId', { ids: [7], categoryId: '3' }],
    ['no body', undefined],
  ])('%s → 400 INVALID_BODY', async (_label, body) => {
    const res = await patch(body);
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('INVALID_BODY');
  });

  it('other methods → 405 with Allow: PATCH', async () => {
    const res = await patch({}, undefined, 'POST');
    expect(res._status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', ['PATCH']);
  });
});

describe('PATCH /api/transactions/bulk — access (#141)', () => {
  it('a viewer session is refused', async () => {
    const own = await createTxs(tenantA, a, 1, a.dining, 10);
    const viewer = await createTenantUser(tenantA.tenantId, 'viewer');
    const res = await patch({ ids: own, categoryId: a.groceries }, { cookies: { token: viewer.token } });
    expect(res._status).toBe(403);
    expect(await categoriesOf(own)).toEqual([a.dining]);
  });

  it('a Read-only key is refused with READ_ONLY_INTEGRATION', async () => {
    const own = await createTxs(tenantA, a, 1, a.dining, 10);
    const { token } = await createIntegrationKey(tenantA, { accessLevel: 'READ_ONLY' });
    const res = await patch({ ids: own, categoryId: a.groceries }, { headers: bearer(token) });
    expect(res._status).toBe(403);
    expect(res._body.code).toBe('READ_ONLY_INTEGRATION');
    expect(await categoriesOf(own)).toEqual([a.dining]);
  });

  it('a Read & write key succeeds and the event is labelled as agent work', async () => {
    const own = await createTxs(tenantA, a, 2, a.dining, 10);
    const { token } = await createIntegrationKey(tenantA, { accessLevel: 'READ_WRITE' });
    const res = await patch({ ids: own, categoryId: a.groceries }, { headers: bearer(token) });
    expect(res._status).toBe(200);
    expect(await categoriesOf(own)).toEqual([a.groceries, a.groceries]);
    expect((vi.mocked(produceEvent).mock.calls[0][0] as any)._trigger).toBe('agent');
  });
});
