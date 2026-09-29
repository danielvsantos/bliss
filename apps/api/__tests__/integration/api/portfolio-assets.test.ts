/**
 * Integration tests for GET /api/portfolio/assets (Manage Assets #81) and
 * GET /api/portfolio/items/:assetId/asset-class, against the real bliss_test
 * Postgres — exercises the actual Prisma queries (Decimal quantity filter,
 * manualAssetValue.groupBy, detached-terms count) and tenant isolation.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next()
  ),
}));

import assetsHandler from '../../../pages/api/portfolio/assets.js';
import assetClassHandler from '../../../pages/api/portfolio/items/[assetId]/asset-class.js';
import prisma from '../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant } from '../../helpers/tenant.js';
import { ensureReferenceData } from '../../helpers/referenceData.js';

function makeReq(token: string, query: Record<string, string> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    body: {},
    query,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = { _status: undefined, _body: undefined };
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  res.json = vi.fn((body: unknown) => { res._body = body; return res; });
  res.setHeader = vi.fn();
  res.end = vi.fn(() => res);
  return res;
}

async function list(token: string, query: Record<string, string> = {}) {
  const res = makeRes();
  await assetsHandler(makeReq(token, query), res as unknown as NextApiResponse);
  return res;
}

const SUFFIX = `${Date.now()}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('Manage Assets API (integration)', () => {
  let tenantId: string;
  let token: string;
  let otherTenantId: string;
  let otherToken: string;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ({ tenantId, token } = await createIsolatedTenant('manage-assets'));
    ({ tenantId: otherTenantId, token: otherToken } = await createIsolatedTenant('manage-assets-other'));

    const cat = (data: any) => prisma.category.create({ data: { tenantId, ...data } });
    const stocks = await cat({ name: 'Stocks', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK', defaultCategoryCode: 'STOCKS' });
    const realEstate = await cat({ name: 'Real Estate', group: 'Real Estate', type: 'Asset', processingHint: 'MANUAL', defaultCategoryCode: 'REAL_ESTATE' });
    const mortgage = await cat({ name: 'Mortgage', group: 'Real Estate Loan', type: 'Debt', processingHint: 'AMORTIZING_LOAN', defaultCategoryCode: 'MORTGAGE' });
    const { countryId, currencyCode, bankId } = await ensureReferenceData();
    const account = await prisma.account.create({
      data: { tenantId, name: 'Broker', accountNumber: `MA-${SUFFIX}`, bankId, currencyCode, countryId },
    });

    const item = (data: any) => prisma.portfolioItem.create({ data: { tenantId, currency: 'USD', source: 'SYNCED', ...data } });
    ids.stock = (await item({ categoryId: stocks.id, symbol: `MA-AAA-${SUFFIX}`, quantity: 10, currentValue: 1000, currentValueInUSD: 1000, accountId: account.id })).id;
    ids.override = (await item({ categoryId: stocks.id, symbol: `MA-BBB-${SUFFIX}`, quantity: 5, currentValue: 500, currentValueInUSD: 500, assetClassOverride: 'REIT', hasLotMismatch: true })).id;
    ids.closed = (await item({ categoryId: stocks.id, symbol: `MA-CCC-${SUFFIX}`, quantity: 0, currentValue: 0, currentValueInUSD: 0 })).id;
    ids.flat = (await item({ categoryId: realEstate.id, symbol: `Flat ${SUFFIX}`, source: 'MANUAL', quantity: 1, currentValue: 300000, currentValueInUSD: 300000 })).id;
    ids.freshFlat = (await item({ categoryId: realEstate.id, symbol: `House ${SUFFIX}`, source: 'MANUAL', quantity: 1, currentValue: 200000, currentValueInUSD: 200000 })).id;
    ids.mortgage = (await item({ categoryId: mortgage.id, symbol: `Mortgage ${SUFFIX}`, source: 'MANUAL', quantity: 0, currentValue: -150000, currentValueInUSD: -150000 })).id;

    await prisma.manualAssetValue.createMany({
      data: [
        { tenantId, assetId: ids.flat, date: daysAgo(400), value: 280000, currency: 'USD' },
        { tenantId, assetId: ids.flat, date: daysAgo(45), value: 300000, currency: 'USD' },
        { tenantId, assetId: ids.freshFlat, date: daysAgo(3), value: 200000, currency: 'USD' },
      ],
    });
    await prisma.incomeTerms.create({
      data: { tenantId, assetId: ids.flat, incomeType: 'RENT', frequency: 'MONTHLY', monthlyRent: 1200, currency: 'USD' },
    });
    await prisma.incomeTerms.create({
      data: { tenantId, incomeType: 'RENT', frequency: 'MONTHLY', monthlyRent: 900, currency: 'USD', orphanedAt: new Date(), orphanedLabel: 'Old flat' },
    });

    const otherCat = await prisma.category.create({ data: { tenantId: otherTenantId, name: 'Stocks', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK' } });
    ids.other = (await prisma.portfolioItem.create({
      data: { tenantId: otherTenantId, categoryId: otherCat.id, symbol: `MA-OTHER-${SUFFIX}`, currency: 'USD', source: 'SYNCED', quantity: 1 },
    })).id;
  });

  afterAll(async () => {
    await teardownTenant(tenantId);
    await teardownTenant(otherTenantId);
  });

  it('lists open positions and debts, hides closed ones, and never returns history', async () => {
    const res = await list(token);
    expect(res._status).toBe(200);
    const got = res._body.items.map((r: any) => r.id);
    expect(got).toEqual(expect.arrayContaining([ids.stock, ids.override, ids.flat, ids.freshFlat, ids.mortgage]));
    expect(got).not.toContain(ids.closed);
    expect(got).not.toContain(ids.other);
    expect(res._body.totals.count).toBe(5);
    expect(res._body.detachedTermsCount).toBe(1);
    for (const row of res._body.items) expect(row).not.toHaveProperty('manualValues');
    expect(res._body.facets.accounts).toEqual([{ id: expect.any(Number), name: 'Broker' }]);
  });

  it('includes closed positions on request', async () => {
    const res = await list(token, { includeClosed: 'true' });
    expect(res._body.items.map((r: any) => r.id)).toContain(ids.closed);
  });

  it('returns the latest manual value date and the stale flag', async () => {
    const rows = (await list(token))._body.items;
    const flat = rows.find((r: any) => r.id === ids.flat);
    const fresh = rows.find((r: any) => r.id === ids.freshFlat);
    expect(new Date(flat.lastManualValueDate).getTime()).toBeGreaterThan(daysAgo(46).getTime());
    expect(flat.isPriceStale).toBe(true);
    expect(fresh.isPriceStale).toBe(false);
    expect(flat).toMatchObject({ hasIncomeTerms: true, incomeDataStatus: 'MANUAL', assetClass: 'REAL_ESTATE' });
    expect(fresh.incomeDataStatus).toBe('MISSING');
  });

  it('puts what needs attention first and counts it (Postgres)', async () => {
    const res = await list(token);
    // stale price (45d) · mortgage without debt terms · then income terms missing
    // (the house, and both stocks — no SecurityMaster dividend data) by group/symbol.
    expect(res._body.items.map((r: any) => r.id)).toEqual([ids.flat, ids.mortgage, ids.freshFlat, ids.stock, ids.override]);
    expect(res._body.totals).toEqual({ count: 5, attention: 5 });
    expect(res._body.statusCounts).toEqual({
      stale: 1, debtTermsMissing: 1, incomeMissing: 3, lotMismatch: 1, dividendOverride: 0, assetClassOverridden: 1,
    });
    const byName = await list(token, { sort: 'name' });
    expect(byName._body.items.map((r: any) => r.id)).not.toEqual(res._body.items.map((r: any) => r.id));
  });

  it('filters on the server', async () => {
    const ids_ = async (q: Record<string, string>) => (await list(token, q))._body.items.map((r: any) => r.id).sort();
    expect(await ids_({ type: 'Real Estate' })).toEqual([ids.flat, ids.freshFlat].sort());
    expect(await ids_({ type: 'MANUAL' })).toEqual([ids.flat, ids.freshFlat].sort());
    expect(await ids_({ assetClass: 'REIT' })).toEqual([ids.override]);
    expect(await ids_({ status: 'stale' })).toEqual([ids.flat]);
    expect(await ids_({ status: 'lotMismatch' })).toEqual([ids.override]);
    expect(await ids_({ search: `house ${SUFFIX}` })).toEqual([ids.freshFlat]);
    const accountId = (await list(token))._body.facets.accounts[0].id;
    expect(await ids_({ accountId: String(accountId) })).toEqual([ids.stock]);
  });

  it('paginates without duplicates or gaps', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await list(token, { limit: '2', ...(cursor ? { cursor } : {}) });
      seen.push(...res._body.items.map((r: any) => r.id));
      cursor = res._body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('isolates tenants, including single-item lookups', async () => {
    const res = await list(otherToken);
    expect(res._body.items.map((r: any) => r.id)).toEqual([ids.other]);
    expect(res._body.detachedTermsCount).toBe(0);
    expect((await list(otherToken, { id: String(ids.flat) }))._body.items).toEqual([]);
    expect((await list(token, { id: String(ids.flat) }))._body.items.map((r: any) => r.id)).toEqual([ids.flat]);
  });

  it('GET asset-class returns the override and the automatic class, tenant-scoped', async () => {
    const res = makeRes();
    await assetClassHandler(
      { ...makeReq(token), query: { assetId: String(ids.override) } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse,
    );
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ assetClass: 'REIT', assetClassSource: 'OVERRIDE', autoAssetClass: 'STOCK' });

    const other = makeRes();
    await assetClassHandler(
      { ...makeReq(otherToken), query: { assetId: String(ids.override) } } as unknown as NextApiRequest,
      other as unknown as NextApiResponse,
    );
    expect(other._status).toBe(404);
  });
});
