/**
 * Integration tests — tenant ownership of account/category IDs on transaction
 * writes (#90).
 *
 * Real bliss_test Postgres and the real withAuth. Two isolated tenants: a
 * caller in tenant A (cookie session and Read & write integration token) must
 * not be able to create or update a tenant-A transaction that points at tenant
 * B's account or category, and nothing (Transaction, PortfolioItem, tag) may be
 * written when the request is rejected.
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

import transactionsHandler from '../../../pages/api/transactions/index.js';
import prisma from '../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant, type IsolatedTenant } from '../../helpers/tenant.js';
import { ensureReferenceData } from '../../helpers/referenceData.js';
import { bearer, createIntegrationKey } from '../../helpers/integration.js';

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', url: '/api/transactions', headers: {}, cookies: {}, body: {}, query: {}, ...overrides } as any;
}

function makeRes() {
  const res: any = { _status: undefined, _body: undefined, statusCode: 200 };
  res.status = vi.fn((code: number) => { res._status = code; res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.setHeader = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

async function call(req: any) {
  const res = makeRes();
  await transactionsHandler(req, res);
  return res;
}

interface Seeded {
  accountId: number;
  categoryId: number;
  investmentCategoryId: number;
  transactionId: number;
}

async function seed(tenant: IsolatedTenant, label: string): Promise<Seeded> {
  const ref = await ensureReferenceData();
  const category = await prisma.category.create({
    data: { name: `Groceries ${label}`, group: 'Food', type: 'Essentials', tenantId: tenant.tenantId },
  });
  const investmentCategory = await prisma.category.create({
    data: {
      name: `Stocks ${label}`,
      group: 'Stocks',
      type: 'Investments',
      processingHint: 'API_STOCK',
      portfolioItemKeyStrategy: 'TICKER',
      tenantId: tenant.tenantId,
    },
  });
  const account = await prisma.account.create({
    data: {
      name: `Checking ${label}`,
      accountNumber: `0000${label}`,
      bankId: ref.bankId,
      countryId: ref.countryId,
      currencyCode: ref.currencyCode,
      tenantId: tenant.tenantId,
    },
  });
  const tx = await prisma.transaction.create({
    data: {
      transaction_date: new Date('2026-01-15T00:00:00Z'),
      year: 2026, month: 1, day: 15, quarter: 'Q1',
      categoryId: category.id,
      accountId: account.id,
      description: `${label} purchase`,
      debit: 10,
      currency: 'USD',
      tenantId: tenant.tenantId,
    },
  });
  return { accountId: account.id, categoryId: category.id, investmentCategoryId: investmentCategory.id, transactionId: tx.id };
}

let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let a: Seeded;
let b: Seeded;
let readWriteToken: string;

beforeAll(async () => {
  tenantA = await createIsolatedTenant('own-a');
  tenantB = await createIsolatedTenant('own-b');
  a = await seed(tenantA, 'A');
  b = await seed(tenantB, 'B');
  readWriteToken = (await createIntegrationKey(tenantA, { accessLevel: 'READ_WRITE' })).token;
});

afterAll(async () => {
  await teardownTenant(tenantA.tenantId);
  await teardownTenant(tenantB.tenantId);
});

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;
});

async function tenantSnapshot(tenantId: string) {
  const [transactions, portfolioItems, tags] = await Promise.all([
    prisma.transaction.count({ where: { tenantId } }),
    prisma.portfolioItem.count({ where: { tenantId } }),
    prisma.tag.count({ where: { tenantId } }),
  ]);
  return { transactions, portfolioItems, tags };
}

const callers = [
  { name: 'cookie session', auth: () => ({ cookies: { token: tenantA.token } }) },
  { name: 'Read & write integration token', auth: () => ({ headers: bearer(readWriteToken) }) },
];

describe.each(callers)('POST /api/transactions — foreign IDs ($name)', ({ auth }) => {
  const body = (overrides: Record<string, unknown>) => ({
    transaction_date: '2026-02-01',
    description: 'Cross-tenant attempt',
    debit: 25,
    currency: 'USD',
    ticker: 'AAPL',
    assetQuantity: 1,
    assetPrice: 25,
    tags: ['cross-tenant-tag'],
    ...overrides,
  });

  it.each([
    ['tenant B category', () => ({ categoryId: b.investmentCategoryId, accountId: a.accountId })],
    ['tenant B account', () => ({ categoryId: a.investmentCategoryId, accountId: b.accountId })],
    ['tenant B account and category', () => ({ categoryId: b.investmentCategoryId, accountId: b.accountId })],
  ])('rejects %s with 400 and writes nothing', async (_label, ids) => {
    const beforeA = await tenantSnapshot(tenantA.tenantId);
    const beforeB = await tenantSnapshot(tenantB.tenantId);

    const res = await call(makeReq({ method: 'POST', body: body(ids()), ...auth() }));

    expect(res._status).toBe(400);
    expect(await tenantSnapshot(tenantA.tenantId)).toEqual(beforeA);
    expect(await tenantSnapshot(tenantB.tenantId)).toEqual(beforeB);
  });

  it('rejects a missing categoryId with 400', async () => {
    const res = await call(makeReq({ method: 'POST', body: body({ accountId: a.accountId }), ...auth() }));
    expect(res._status).toBe(400);
  });
});

describe('POST /api/transactions — own IDs (control)', () => {
  it('creates the transaction and its PortfolioItem in tenant A', async () => {
    const res = await call(makeReq({
      method: 'POST',
      cookies: { token: tenantA.token },
      body: {
        transaction_date: '2026-02-01',
        categoryId: a.investmentCategoryId,
        accountId: a.accountId,
        description: 'Own buy',
        debit: 25,
        currency: 'USD',
        ticker: 'MSFT',
        assetQuantity: 1,
        assetPrice: 25,
      },
    }));

    expect(res._status).toBe(201);
    const item = await prisma.portfolioItem.findFirst({ where: { tenantId: tenantA.tenantId, symbol: 'MSFT' } });
    expect(item).toMatchObject({ accountId: a.accountId, categoryId: a.investmentCategoryId });
  });
});

describe.each(callers)('PUT /api/transactions — foreign IDs ($name)', ({ auth }) => {
  it.each([
    ['tenant B category', () => ({ categoryId: b.investmentCategoryId, accountId: a.accountId })],
    ['tenant B account', () => ({ categoryId: a.investmentCategoryId, accountId: b.accountId })],
  ])('rejects moving the transaction to %s and leaves it unchanged', async (_label, ids) => {
    const before = await prisma.transaction.findUnique({ where: { id: a.transactionId } });
    const beforeA = await tenantSnapshot(tenantA.tenantId);
    const beforeB = await tenantSnapshot(tenantB.tenantId);

    const res = await call(makeReq({
      method: 'PUT',
      url: `/api/transactions?id=${a.transactionId}`,
      query: { id: String(a.transactionId) },
      body: {
        transaction_date: '2026-01-15',
        description: 'Moved',
        debit: 10,
        currency: 'USD',
        ticker: 'AAPL',
        tags: ['cross-tenant-tag'],
        ...ids(),
      },
      ...auth(),
    }));

    expect(res._status).toBe(400);
    const after = await prisma.transaction.findUnique({ where: { id: a.transactionId } });
    expect(after).toMatchObject({
      accountId: before!.accountId,
      categoryId: before!.categoryId,
      description: before!.description,
    });
    expect(await tenantSnapshot(tenantA.tenantId)).toEqual(beforeA);
    expect(await tenantSnapshot(tenantB.tenantId)).toEqual(beforeB);
  });
});
