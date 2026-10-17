/**
 * Integration tests — amount range filter on GET /api/transactions (#141).
 *
 * `amountMin` / `amountMax` are unsigned, inclusive, in the transaction's own
 * currency, matched against whichever of credit / debit is set at 2-decimal
 * precision. They combine with the other filters and apply to `total` and
 * `totals`. Real bliss_test Postgres and the real withAuth.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: vi.fn().mockResolvedValue(undefined),
}));

import transactionsHandler from '../../../pages/api/transactions/index.js';
import prisma from '../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../helpers/tenant.js';
import { ensureReferenceData } from '../../helpers/referenceData.js';

function makeRes() {
  const res: any = { _status: undefined, _body: undefined, statusCode: 200 };
  res.status = vi.fn((code: number) => { res._status = code; res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.setHeader = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

async function list(query: Record<string, string>) {
  const req = {
    method: 'GET', url: '/api/transactions', headers: {}, cookies: { token: tenant.token }, body: {}, query,
  } as any;
  const res = makeRes();
  await transactionsHandler(req, res);
  return res;
}

let tenant: IsolatedTenant;
let foodId: number;
let rentId: number;
const ids: Record<string, number> = {};

beforeAll(async () => {
  tenant = await createIsolatedTenant('amount');
  const ref = await ensureReferenceData({ currencyCode: 'EUR' });
  const food = await prisma.category.create({ data: { name: 'Groceries amt', group: 'Food', type: 'Essentials', tenantId: tenant.tenantId } });
  const rent = await prisma.category.create({ data: { name: 'Rent amt', group: 'Housing', type: 'Essentials', tenantId: tenant.tenantId } });
  foodId = food.id;
  rentId = rent.id;
  const account = await prisma.account.create({
    data: {
      name: 'Checking amt', accountNumber: '0000AMT', bankId: ref.bankId, countryId: ref.countryId,
      currencyCode: 'EUR', tenantId: tenant.tenantId,
    },
  });

  const rows: Array<[string, string, number, { credit?: number; debit?: number }]> = [
    ['rent', '2026-03-01', rentId, { debit: 2003.76 }],
    ['nearMiss', '2026-03-02', rentId, { debit: 2003.77 }],
    ['refund', '2026-03-03', foodId, { credit: 150 }],
    ['groceries', '2026-03-04', foodId, { debit: 100 }],
    ['bigShop', '2026-03-05', foodId, { debit: 200.004 }],
    ['small', '2026-03-06', foodId, { debit: 99.99 }],
    ['rentApril', '2026-04-01', rentId, { debit: 2003.76 }],
  ];
  for (const [key, date, categoryId, amount] of rows) {
    const d = new Date(`${date}T00:00:00Z`);
    const tx = await prisma.transaction.create({
      data: {
        transaction_date: d, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), quarter: 'Q1',
        categoryId, accountId: account.id, description: `amount ${key}`, currency: 'EUR', tenantId: tenant.tenantId,
        ...amount,
      },
    });
    ids[key] = tx.id;
  }
});

afterAll(async () => {
  await teardownTenant(tenant.tenantId);
});

const idsOf = (res: any) => res._body.transactions.map((t: any) => t.id).sort((a: number, b: number) => a - b);

describe('GET /api/transactions — amount filter (#141)', () => {
  it('finds the €2,003.76 payment with an exact amount inside a date range', async () => {
    const res = await list({ amountMin: '2003.76', amountMax: '2003.76', startDate: '2026-03-01', endDate: '2026-03-31' });
    expect(res._status).toBe(200);
    expect(idsOf(res)).toEqual([ids.rent]);
    expect(res._body.total).toBe(1);
    expect(res._body.filters).toMatchObject({ amountMin: 2003.76, amountMax: 2003.76 });
  });

  it('without a date range the same amount in another month also matches', async () => {
    const res = await list({ amountMin: '2003.76', amountMax: '2003.76' });
    expect(idsOf(res)).toEqual([ids.rent, ids.rentApril].sort((a, b) => a - b));
  });

  it('a range matches credits and debits inclusively and filters total / totals', async () => {
    const res = await list({ amountMin: '100', amountMax: '200', currencyCode: 'EUR' });
    // 99.99 is out; 200.004 rounds to 200.00 and is in; the 150 credit is in.
    expect(idsOf(res)).toEqual([ids.refund, ids.groceries, ids.bigShop].sort((a, b) => a - b));
    expect(res._body.total).toBe(3);
    expect(Number(res._body.totals.credit)).toBeCloseTo(150, 6);
    expect(Number(res._body.totals.debit)).toBeCloseTo(300.004, 6);
  });

  it('combines with a category filter', async () => {
    const res = await list({ amountMin: '2003.76', amountMax: '2003.77', categoryId: String(rentId), startDate: '2026-03-01', endDate: '2026-03-31' });
    expect(idsOf(res)).toEqual([ids.rent, ids.nearMiss].sort((a, b) => a - b));
    const none = await list({ amountMin: '2003.76', amountMax: '2003.76', categoryId: String(foodId) });
    expect(none._body.total).toBe(0);
  });

  it('a single bound is open on the other side', async () => {
    const res = await list({ amountMin: '2000' });
    expect(idsOf(res)).toEqual([ids.rent, ids.nearMiss, ids.rentApril].sort((a, b) => a - b));
  });

  it.each([
    [{ amountMin: '-5' }],
    [{ amountMax: 'abc' }],
    [{ amountMin: '300', amountMax: '200' }],
  ])('rejects %o with 400', async (query) => {
    const res = await list(query as Record<string, string>);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/amount/);
  });
});
