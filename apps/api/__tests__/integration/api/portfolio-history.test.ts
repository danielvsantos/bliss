/**
 * Integration tests for the holding scope (#131) of GET /api/portfolio/history,
 * against the real bliss_test Postgres: the cross-account sum by symbol, the
 * single-account position, id-keyed manual items, tenant isolation and an
 * integration-key (read-only) scoped call.
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

vi.mock('../../../utils/produceEvent.js', () => ({
  produceEvent: vi.fn().mockResolvedValue(undefined),
}));

import historyHandler from '../../../pages/api/portfolio/history.js';
import prisma from '../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant } from '../../helpers/tenant.js';
import { ensureReferenceData } from '../../helpers/referenceData.js';
import { bearer, createIntegrationKey } from '../../helpers/integration.js';

function makeReq(headers: Record<string, string>, query: Record<string, string> = {}): NextApiRequest {
  const qs = new URLSearchParams(query).toString();
  return {
    method: 'GET',
    url: `/api/portfolio/history${qs ? `?${qs}` : ''}`,
    headers,
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

const SUFFIX = `${Date.now()}`;
const D1 = '2026-03-01';
const D2 = '2026-03-02';
const RANGE = { from: D1, to: D2, resolution: 'daily' };

async function get(headers: Record<string, string>, query: Record<string, string>) {
  const res = makeRes();
  await historyHandler(makeReq(headers, query), res as unknown as NextApiResponse);
  return res;
}

/** Latest point's total for a response (USD tenant). */
const latest = (res: any) => res._body.history[res._body.history.length - 1]?.totalUSD;

describe('GET /api/portfolio/history — holding scope (integration)', () => {
  let tenantId: string;
  let userId: string;
  let token: string;
  let otherTenantId: string;
  const ids: Record<string, number> = {};
  const SYM = `AAPL-${SUFFIX}`;

  beforeAll(async () => {
    ({ tenantId, userId, token } = await createIsolatedTenant('history-scope'));
    ({ tenantId: otherTenantId } = await createIsolatedTenant('history-scope-other'));
    await prisma.tenant.update({ where: { id: tenantId }, data: { portfolioCurrency: 'USD' } });

    const { countryId, currencyCode, bankId } = await ensureReferenceData();
    const account = (name: string, tId = tenantId) => prisma.account.create({
      data: { tenantId: tId, name, accountNumber: `HS-${name.replace(' ', '')}-${SUFFIX}`, bankId, currencyCode, countryId },
    });
    ids.accountA = (await account('Broker A')).id;
    ids.accountB = (await account('Broker B')).id;

    const stocks = await prisma.category.create({
      data: { tenantId, name: 'Stocks', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK' },
    });
    const realEstate = await prisma.category.create({
      data: { tenantId, name: 'Real Estate', group: 'Real Estate', type: 'Asset', processingHint: 'MANUAL' },
    });

    const item = (data: any) => prisma.portfolioItem.create({ data: { tenantId, currency: 'USD', source: 'SYNCED', ...data } });
    ids.aaplA = (await item({ categoryId: stocks.id, symbol: SYM, quantity: 10, accountId: ids.accountA })).id;
    ids.aaplB = (await item({ categoryId: stocks.id, symbol: SYM, quantity: 5, accountId: ids.accountB })).id;
    ids.msft = (await item({ categoryId: stocks.id, symbol: `MSFT-${SUFFIX}`, quantity: 1, accountId: ids.accountA })).id;
    // Two manual items sharing a placeholder symbol — must stay separate by id.
    ids.flat1 = (await item({ categoryId: realEstate.id, symbol: `Property ${SUFFIX}`, source: 'MANUAL', quantity: 1 })).id;
    ids.flat2 = (await item({ categoryId: realEstate.id, symbol: `Property ${SUFFIX}`, source: 'MANUAL', quantity: 1 })).id;

    const otherCat = await prisma.category.create({
      data: { tenantId: otherTenantId, name: 'Stocks', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK' },
    });
    ids.other = (await prisma.portfolioItem.create({
      data: { tenantId: otherTenantId, categoryId: otherCat.id, symbol: SYM, currency: 'USD', source: 'SYNCED', quantity: 1 },
    })).id;

    const row = (assetId: number, date: string, value: number) => ({
      assetId, date: new Date(`${date}T00:00:00Z`), nativeValue: value, nativeCurrency: 'USD', valueInUSD: value, source: 'TEST',
    });
    await prisma.portfolioValueHistory.createMany({
      data: [
        row(ids.aaplA, D1, 5500), row(ids.aaplA, D2, 6000),
        row(ids.aaplB, D1, 3500), row(ids.aaplB, D2, 4000),
        row(ids.msft, D1, 900), row(ids.msft, D2, 1000),
        row(ids.flat1, D1, 300000), row(ids.flat1, D2, 300000),
        row(ids.flat2, D1, 200000), row(ids.flat2, D2, 200000),
        row(ids.other, D1, 999999), row(ids.other, D2, 999999),
      ],
    });
  });

  afterAll(async () => {
    await teardownTenant(tenantId);
    await teardownTenant(otherTenantId);
  });

  const auth = () => bearer(token);

  it('sums a symbol across accounts under "All accounts"', async () => {
    const res = await get(auth(), { ...RANGE, symbol: SYM });
    expect(res._status).toBe(200);
    expect(res._body.history.map((h: any) => h.totalUSD)).toEqual([9000, 10000]);
    expect(res._body.history[1].Investments).toEqual({ total: 10000, groups: { Stocks: 10000 } });
  });

  it('returns only one account\'s position when accountId is combined', async () => {
    const res = await get(auth(), { ...RANGE, symbol: SYM, accountId: String(ids.accountA) });
    expect(latest(res)).toBe(6000);
  });

  it('keeps manual items with a shared symbol separate via itemId', async () => {
    expect(latest(await get(auth(), { ...RANGE, itemId: String(ids.flat1) }))).toBe(300000);
    expect(latest(await get(auth(), { ...RANGE, itemId: String(ids.flat2) }))).toBe(200000);
  });

  it('never returns another tenant\'s item by itemId', async () => {
    const res = await get(auth(), { ...RANGE, itemId: String(ids.other) });
    expect(res._status).toBe(200);
    expect(res._body.history).toEqual([]);
  });

  it('returns the unscoped totals unchanged without a scope', async () => {
    const res = await get(auth(), RANGE);
    expect(latest(res)).toBe(6000 + 4000 + 1000 + 300000 + 200000);
  });

  it('serves a scoped request to a read-only integration key', async () => {
    const { token: key } = await createIntegrationKey({ tenantId, userId }, { accessLevel: 'READ_ONLY' });
    const res = await get(bearer(key), { ...RANGE, symbol: SYM });
    expect(res._status).toBe(200);
    expect(latest(res)).toBe(10000);
  });
});

/**
 * #137 — weekly sampling against the real Prisma query shapes: a mid-week buy
 * and a sell-off / rebuy are sampled on their own days, not back-dated to the
 * previous sample.
 */
describe('GET /api/portfolio/history — event-day sampling (integration, #137)', () => {
  let tenantId: string;
  let token: string;
  const BUY = '2026-01-20'; // Tuesday
  const SELL = '2025-07-09'; // Wednesday
  const REBUY = '2025-08-29'; // Friday

  beforeAll(async () => {
    ({ tenantId, token } = await createIsolatedTenant('history-events'));
    await prisma.tenant.update({ where: { id: tenantId }, data: { portfolioCurrency: 'USD' } });

    const { countryId, currencyCode, bankId } = await ensureReferenceData();
    const account = await prisma.account.create({
      data: { tenantId, name: 'Broker', accountNumber: `HE-${SUFFIX}`, bankId, currencyCode, countryId },
    });
    const crypto = await prisma.category.create({
      data: { tenantId, name: 'Crypto', group: 'Crypto', type: 'Investments', processingHint: 'API_CRYPTO' },
    });
    const copy = await prisma.category.create({
      data: { tenantId, name: 'Copy', group: 'Copy Trading', type: 'Investments', processingHint: 'MANUAL' },
    });
    const btc = await prisma.portfolioItem.create({
      data: { tenantId, categoryId: crypto.id, symbol: `BTC-${SUFFIX}`, currency: 'USD', source: 'SYNCED', quantity: 1, accountId: account.id },
    });
    const copyItem = await prisma.portfolioItem.create({
      data: { tenantId, categoryId: copy.id, symbol: `Copy ${SUFFIX}`, currency: 'USD', source: 'MANUAL', quantity: 1 },
    });

    // Daily rows like the valuation worker writes: BTC held 2025-06-01 → sell
    // day (0 on it), nothing in the gap, back from the rebuy day; the copy
    // trade from its buy day only.
    const rows: Array<{ assetId: number; date: Date; nativeValue: number; nativeCurrency: string; valueInUSD: number; source: string }> = [];
    const push = (assetId: number, from: string, to: string, value: (d: string) => number) => {
      for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
        const v = value(d.toISOString().split('T')[0]);
        rows.push({ assetId, date: new Date(d), nativeValue: v, nativeCurrency: 'USD', valueInUSD: v, source: 'TEST' });
      }
    };
    push(btc.id, '2025-06-01', SELL, (d) => (d === SELL ? 0 : 1000));
    push(btc.id, REBUY, '2026-03-01', () => 800);
    push(copyItem.id, BUY, '2026-03-01', () => 500);
    await prisma.portfolioValueHistory.createMany({ data: rows });

    const tx = (date: string, debit: number | null, credit: number | null) => {
      const d = new Date(`${date}T00:00:00Z`);
      return {
        tenantId, accountId: account.id, categoryId: crypto.id, portfolioItemId: btc.id,
        transaction_date: d, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        quarter: `Q${Math.floor(d.getUTCMonth() / 3) + 1}`, description: 'BTC trade', currency: 'USD', debit, credit,
      };
    };
    await prisma.transaction.create({ data: tx('2025-06-01', 1000, null) });
    await prisma.transaction.create({ data: tx(SELL, null, 1000) });
    await prisma.transaction.create({ data: tx(REBUY, 800, null) });
  });

  afterAll(async () => {
    await teardownTenant(tenantId);
  });

  it('samples ALL weekly and includes buy / sell / rebuy days', async () => {
    const res = await get(bearer(token), { to: '2026-03-01' });

    expect(res._status).toBe(200);
    expect(res._body.resolution).toBe('weekly');
    const byDate = new Map<string, any>(res._body.history.map((h: any) => [h.date, h]));
    const group = (d: string, g: string) => byDate.get(d)?.Investments?.groups?.[g];

    // Weekly, not daily: ~39 weeks plus a handful of event days.
    expect(res._body.history.length).toBeLessThan(50);

    // The copy trade appears on its buy day, and on no sample before it.
    expect(group(BUY, 'Copy Trading')).toBe(500);
    const before = res._body.history.filter((h: any) => h.date < BUY);
    expect(before.every((h: any) => h.Investments?.groups?.['Copy Trading'] === undefined)).toBe(true);

    // BTC drops to zero on the sell day and is back on the rebuy day.
    expect(group(SELL, 'Crypto')).toBe(0);
    expect(group(REBUY, 'Crypto')).toBe(800);
    // Starts on the first valuation, not a sample before it.
    expect(res._body.history[0].date).toBe('2025-06-01');
  });
});
