/**
 * Integration tests — PUT /api/transactions skips no-op edits (#141).
 *
 * Agents (update_transaction) and the edit form resend the whole record. When
 * nothing persisted changes, the route writes nothing, sends no classifier
 * feedback and emits no events, and still answers 200 with the transaction.
 * Real bliss_test Postgres and the real withAuth; events and fetch are mocked.
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
import { produceEvent } from '../../../utils/produceEvent.js';
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

async function put(body: Record<string, unknown>) {
  const req = {
    method: 'PUT', url: '/api/transactions', headers: {}, cookies: { token: tenant.token },
    body, query: { id: String(txId) },
  } as any;
  const res = makeRes();
  await transactionsHandler(req, res);
  return res;
}

let tenant: IsolatedTenant;
let accountId: number;
let categoryId: number;
let otherCategoryId: number;
let txId: number;
let tagIds: number[];

// The record exactly as update_transaction resends it (no tags key).
const current = () => ({
  transaction_date: '2026-02-10',
  accountId,
  categoryId,
  description: 'Corner cafe',
  details: null,
  currency: 'USD',
  credit: null,
  debit: 12.5,
  ticker: null,
  assetQuantity: null,
  assetPrice: null,
  isin: null,
  exchange: null,
  assetCurrency: null,
});

const fetchMock = vi.fn();

beforeAll(async () => {
  tenant = await createIsolatedTenant('noop-put');
  const ref = await ensureReferenceData();
  const cafe = await prisma.category.create({ data: { name: 'Cafes noop', group: 'Food', type: 'Lifestyle', tenantId: tenant.tenantId } });
  const other = await prisma.category.create({ data: { name: 'Snacks noop', group: 'Food', type: 'Lifestyle', tenantId: tenant.tenantId } });
  categoryId = cafe.id;
  otherCategoryId = other.id;
  const account = await prisma.account.create({
    data: {
      name: 'Checking noop', accountNumber: '0000NOOP', bankId: ref.bankId, countryId: ref.countryId,
      currencyCode: ref.currencyCode, tenantId: tenant.tenantId,
    },
  });
  accountId = account.id;
  const tags = await Promise.all(['coffee', 'work'].map((name) => prisma.tag.create({ data: { name, tenantId: tenant.tenantId } })));
  tagIds = tags.map((t) => t.id);
  const tx = await prisma.transaction.create({
    data: {
      transaction_date: new Date('2026-02-10T00:00:00Z'), year: 2026, month: 2, day: 10, quarter: 'Q1',
      categoryId, accountId, description: 'Corner cafe', debit: 12.5, currency: 'USD', tenantId: tenant.tenantId,
      tags: { create: tagIds.map((id) => ({ tag: { connect: { id } } })) },
    },
  });
  txId = tx.id;
});

afterAll(async () => {
  await prisma.transactionTag.deleteMany({ where: { transactionId: txId } });
  await teardownTenant(tenant.tenantId);
});

beforeEach(() => {
  vi.mocked(produceEvent).mockClear();
  fetchMock.mockReset().mockResolvedValue({ ok: true });
  global.fetch = fetchMock as any;
});

describe('PUT /api/transactions — no-op edits (#141)', () => {
  it('resubmitting the current values writes nothing and emits no events', async () => {
    const before = await prisma.transaction.findUnique({ where: { id: txId } });
    const res = await put(current());

    expect(res._status).toBe(200);
    expect(produceEvent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await prisma.transaction.findUnique({ where: { id: txId } });
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());

    // Same response shape as a real update.
    expect(res._body).toMatchObject({
      id: txId,
      categoryId,
      accountId,
      description: 'Corner cafe',
      category: { name: 'Cafes noop', group: 'Food', type: 'Lifestyle' },
      account: { name: 'Checking noop' },
    });
    expect(res._body.tags.map((t: any) => t.name).sort()).toEqual(['coffee', 'work']);
  });

  it('resending the same tags in another order (the edit form) is still a no-op', async () => {
    const res = await put({ ...current(), tags: [String(tagIds[1]), 'coffee'] });
    expect(res._status).toBe(200);
    expect(produceEvent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a one-field change still updates and emits MANUAL_TRANSACTION_MODIFIED', async () => {
    const res = await put({ ...current(), details: 'with a friend' });
    expect(res._status).toBe(200);
    expect(res._body.details).toBe('with a friend');
    expect(vi.mocked(produceEvent).mock.calls.map(([e]: any) => e.type)).toEqual(['MANUAL_TRANSACTION_MODIFIED']);
    expect(fetchMock).not.toHaveBeenCalled(); // category unchanged → no feedback

    // And resending that new state is a no-op again.
    vi.mocked(produceEvent).mockClear();
    await put({ ...current(), details: 'with a friend' });
    expect(produceEvent).not.toHaveBeenCalled();
  });

  it('dropping a tag is a change (tag analytics refresh)', async () => {
    const res = await put({ ...current(), details: 'with a friend', tags: ['coffee'] });
    expect(res._status).toBe(200);
    const types = vi.mocked(produceEvent).mock.calls.map(([e]: any) => e.type);
    expect(types).toContain('TAG_ASSIGNMENT_MODIFIED');
  });

  it('a category change sends classifier feedback and both events', async () => {
    const res = await put({ ...current(), details: 'with a friend', tags: ['coffee'], categoryId: otherCategoryId });
    expect(res._status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/feedback$/);
    const types = vi.mocked(produceEvent).mock.calls.map(([e]: any) => e.type);
    // Old and new state; tags were sent, so the tag refresh fires as before.
    expect(types.filter((t) => t === 'MANUAL_TRANSACTION_MODIFIED')).toHaveLength(2);
  });
});
