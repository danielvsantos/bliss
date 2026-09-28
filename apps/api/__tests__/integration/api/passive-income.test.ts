/**
 * Integration tests for Passive Income (#77):
 *   - PUT/GET/DELETE /api/portfolio/items/:assetId/income-terms
 *   - /api/passive-income/streams (+ /:id)
 *   - /api/portfolio/income-terms/detached, /:id (discard), /:id/attach
 *   - GET /api/portfolio/passive-income
 *   - Grouped view (#83): siblings, applyToSymbol for every non-cash type,
 *     DELETE ?applyToSymbol=true, groups / missingGroups / grouped upcoming payments
 *
 * Calls the Next.js handlers directly against the real bliss_test Postgres
 * (so the IncomeTerms owner CHECK constraint and unique assetId index are
 * exercised). Rate limiter is mocked to a no-op.
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

import incomeTermsHandler from '../../../pages/api/portfolio/items/[assetId]/income-terms.js';
import streamsHandler from '../../../pages/api/passive-income/streams/index.js';
import streamHandler from '../../../pages/api/passive-income/streams/[id].js';
import detachedHandler from '../../../pages/api/portfolio/income-terms/detached.js';
import discardHandler from '../../../pages/api/portfolio/income-terms/[id].js';
import attachHandler from '../../../pages/api/portfolio/income-terms/[id]/attach.js';
import passiveIncomeHandler from '../../../pages/api/portfolio/passive-income.js';
import prisma from '../../../prisma/prisma.js';
import { createIsolatedTenant, teardownTenant } from '../../helpers/tenant.js';
import { ensureReferenceData } from '../../helpers/referenceData.js';

function makeReq(token: string, overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    body: {},
    query: {},
    ...overrides,
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

async function call(handler: any, token: string, overrides: Partial<NextApiRequest>) {
  const res = makeRes();
  await handler(makeReq(token, overrides), res as unknown as NextApiResponse);
  return res;
}

const SUFFIX = `${Date.now()}`;
const SYMBOL = `PITEST-KO-${SUFFIX}`;

describe('Passive Income API (integration)', () => {
  let tenantId: string;
  let token: string;
  let otherTenantId: string;
  let otherToken: string;
  let stockA: number;
  let stockB: number;
  let bondId: number;
  let cryptoId: number;
  let allowanceId: number;
  let dividendsCatId: number;
  let otherItemId: number;

  beforeAll(async () => {
    ({ tenantId, token } = await createIsolatedTenant('passive-income'));
    ({ tenantId: otherTenantId, token: otherToken } = await createIsolatedTenant('passive-income-other'));

    const cat = (data: any) => prisma.category.create({ data: { tenantId, ...data } });
    const stocks = await cat({ name: 'Stocks', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK', portfolioItemKeyStrategy: 'TICKER', defaultCategoryCode: 'STOCKS' });
    const bonds = await cat({ name: 'Government Bonds', group: 'Bonds', type: 'Investments', processingHint: 'MANUAL', defaultCategoryCode: 'GOVERNMENT_BONDS' });
    const crypto = await cat({ name: 'Crypto', group: 'Crypto', type: 'Investments', processingHint: 'API_CRYPTO' });
    const allowance = await cat({ name: 'Allowance', group: 'Passive Income', type: 'Income', defaultCategoryCode: 'ALLOWANCE' });
    const dividends = await cat({ name: 'Dividends', group: 'Passive Income', type: 'Income', defaultCategoryCode: 'DIVIDENDS' });
    allowanceId = allowance.id;
    dividendsCatId = dividends.id;

    const item = (data: any) => prisma.portfolioItem.create({ data: { tenantId, currency: 'USD', source: 'SYNCED', ...data } });
    stockA = (await item({ categoryId: stocks.id, symbol: SYMBOL, quantity: 100, currentValue: 7000, currentValueInUSD: 7000 })).id;
    // Same symbol in a second holding (unique is per tenant+symbol+account; accountId null twice is allowed by Postgres).
    stockB = (await item({ categoryId: stocks.id, symbol: SYMBOL, quantity: 10, currentValue: 700, currentValueInUSD: 700 })).id;
    bondId = (await item({ categoryId: bonds.id, symbol: 'Government Bonds - Tesouro 2030', source: 'MANUAL', quantity: 10, currentValue: 10000, currentValueInUSD: 10000 })).id;
    cryptoId = (await item({ categoryId: crypto.id, symbol: 'BTC', quantity: 1, currentValue: 50000, currentValueInUSD: 50000 })).id;

    const otherCat = await prisma.category.create({ data: { tenantId: otherTenantId, name: 'Stocks', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK' } });
    otherItemId = (await prisma.portfolioItem.create({ data: { tenantId: otherTenantId, categoryId: otherCat.id, symbol: 'OTHER', currency: 'USD', source: 'SYNCED', quantity: 1 } })).id;

    const exDate = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    await prisma.securityMaster.create({
      data: {
        symbol: SYMBOL,
        assetType: 'Common Stock',
        currency: 'USD',
        dividendTrusted: true,
        recentDividends: [
          { exDate: exDate(10), amount: 0.53 },
          { exDate: exDate(100), amount: 0.51 },
          { exDate: exDate(190), amount: 0.51 },
          { exDate: exDate(280), amount: 0.51 },
        ],
      },
    });
  });

  afterAll(async () => {
    await prisma.securityMaster.deleteMany({ where: { symbol: SYMBOL } });
    await teardownTenant(tenantId);
    await teardownTenant(otherTenantId);
  });

  // ─── Asset income terms ──────────────────────────────────────────────────

  describe('asset income terms', () => {
    it('GET returns asset class, default type and trusted auto dividends', async () => {
      const res = await call(incomeTermsHandler, token, { query: { assetId: String(stockA) } });
      expect(res._status).toBe(200);
      expect(res._body.asset.assetClass).toBe('STOCK');
      expect(res._body.asset.defaultIncomeType).toBe('DIVIDEND');
      expect(res._body.asset).toHaveProperty('costBasis');
      expect(res._body.terms).toBeNull();
      expect(res._body.auto.frequency).toBe('QUARTERLY');
      expect(res._body.auto.recentDividends).toHaveLength(4);
    });

    it('PUT validates required fields per income type', async () => {
      const res = await call(incomeTermsHandler, token, {
        method: 'PUT',
        query: { assetId: String(bondId) },
        body: { incomeType: 'FIXED_COUPON', faceValuePerUnit: 1000 },
      });
      expect(res._status).toBe(400);
      expect(res._body.details.map((d: any) => d.field)).toEqual(
        expect.arrayContaining(['couponRate', 'frequency', 'maturityDate']),
      );
    });

    it('PUT upserts bond terms and defaults the currency to the item currency', async () => {
      const body = { incomeType: 'FIXED_COUPON', faceValuePerUnit: 1000, couponRate: 5, frequency: 'SEMIANNUAL', maturityDate: '2030-06-15', issuerType: 'GOVERNMENT' };
      const res = await call(incomeTermsHandler, token, { method: 'PUT', query: { assetId: String(bondId) }, body });
      expect(res._status).toBe(200);
      expect(res._body.terms.couponRate).toBe(5);
      expect(res._body.terms.currency).toBe('USD');
      // Second PUT updates the same row (1:1 with the asset)
      const again = await call(incomeTermsHandler, token, { method: 'PUT', query: { assetId: String(bondId) }, body: { ...body, couponRate: 6 } });
      expect(again._body.terms.id).toBe(res._body.terms.id);
      expect(again._body.terms.couponRate).toBe(6);
    });

    it('PUT rejects assets that cannot hold income terms (crypto)', async () => {
      const res = await call(incomeTermsHandler, token, {
        method: 'PUT', query: { assetId: String(cryptoId) }, body: { incomeType: 'CUSTOM_YIELD', yieldPct: 3 },
      });
      expect(res._status).toBe(400);
    });

    it('PUT applyToSymbol sets the dividend override on every holding of that symbol', async () => {
      const res = await call(incomeTermsHandler, token, {
        method: 'PUT',
        query: { assetId: String(stockA) },
        body: { incomeType: 'DIVIDEND', dividendPerUnit: 2.2, frequency: 'QUARTERLY', applyToSymbol: true },
      });
      expect(res._status).toBe(200);
      expect(res._body.appliedTo.sort()).toEqual([stockA, stockB].sort());
      const rows = await prisma.incomeTerms.findMany({ where: { assetId: { in: [stockA, stockB] } } });
      expect(rows).toHaveLength(2);
    });

    it('DELETE removes the terms (stock falls back to automatic data)', async () => {
      const res = await call(incomeTermsHandler, token, { method: 'DELETE', query: { assetId: String(stockB) } });
      expect(res._status).toBe(204);
      const missing = await call(incomeTermsHandler, token, { method: 'DELETE', query: { assetId: String(stockB) } });
      expect(missing._status).toBe(404);
    });

    it('enforces tenant isolation', async () => {
      const res = await call(incomeTermsHandler, token, { query: { assetId: String(otherItemId) } });
      expect(res._status).toBe(404);
      const put = await call(incomeTermsHandler, otherToken, {
        method: 'PUT', query: { assetId: String(bondId) }, body: { incomeType: 'NONE' },
      });
      expect(put._status).toBe(404);
    });
  });

  // ─── Streams ─────────────────────────────────────────────────────────────

  describe('income streams', () => {
    let streamId: number;

    it('lists eligible categories (Allowance yes, Dividends no)', async () => {
      const res = await call(streamsHandler, token, {});
      expect(res._status).toBe(200);
      const ids = res._body.eligibleCategories.map((c: any) => c.id);
      expect(ids).toContain(allowanceId);
      expect(ids).not.toContain(dividendsCatId);
    });

    it('rejects an ineligible category', async () => {
      const res = await call(streamsHandler, token, {
        method: 'POST',
        body: { categoryId: dividendsCatId, name: 'x', amountPerPayment: 10, frequency: 'MONTHLY', currency: 'USD', startDate: '2026-01-01' },
      });
      expect(res._status).toBe(400);
    });

    it('creates several streams in one category', async () => {
      const body = { categoryId: allowanceId, name: 'Family allowance', amountPerPayment: 200, frequency: 'MONTHLY', currency: 'USD', startDate: '2026-01-05', annualIndexationPct: 2 };
      const a = await call(streamsHandler, token, { method: 'POST', body });
      const b = await call(streamsHandler, token, { method: 'POST', body: { ...body, name: 'Second' } });
      expect(a._status).toBe(201);
      expect(b._status).toBe(201);
      expect(a._body.categoryName).toBe('Allowance');
      streamId = a._body.id;
    });

    it('validates stream fields', async () => {
      const res = await call(streamsHandler, token, { method: 'POST', body: { categoryId: allowanceId, amountPerPayment: 5 } });
      expect(res._status).toBe(400);
    });

    it('updates and deletes a stream; other tenants get 404', async () => {
      const upd = await call(streamHandler, token, {
        method: 'PUT',
        query: { id: String(streamId) },
        body: { name: 'Family allowance', amountPerPayment: 250, frequency: 'MONTHLY', currency: 'USD', startDate: '2026-01-05' },
      });
      expect(upd._status).toBe(200);
      expect(upd._body.amountPerPayment).toBe(250);

      const foreign = await call(streamHandler, otherToken, { method: 'DELETE', query: { id: String(streamId) } });
      expect(foreign._status).toBe(404);
    });

    it('the database CHECK rejects a row with two owners', async () => {
      await expect(prisma.incomeTerms.create({
        data: { tenantId, incomeType: 'FIXED_AMOUNT', assetId: cryptoId, categoryId: allowanceId },
      })).rejects.toThrow(/IncomeTerms_owner_check/);
      await expect(prisma.incomeTerms.create({
        data: { tenantId, incomeType: 'FIXED_AMOUNT' }, // no owner and not detached
      })).rejects.toThrow(/IncomeTerms_owner_check/);
    });
  });

  // ─── Detached terms ──────────────────────────────────────────────────────

  describe('detached income terms', () => {
    let detachedId: number;

    beforeAll(async () => {
      const row = await prisma.incomeTerms.create({
        data: {
          tenantId, incomeType: 'RENT', monthlyRent: 1200, currency: 'USD',
          orphanedAt: new Date(), orphanedLabel: 'Real Estate - Old flat',
        },
      });
      detachedId = row.id;
    });

    it('lists detached terms for the tenant only', async () => {
      const res = await call(detachedHandler, token, {});
      expect(res._status).toBe(200);
      expect(res._body.detached.map((d: any) => d.id)).toContain(detachedId);
      const other = await call(detachedHandler, otherToken, {});
      expect(other._body.detached).toHaveLength(0);
    });

    it('refuses to attach to an asset that already has terms', async () => {
      const res = await call(attachHandler, token, { method: 'POST', query: { id: String(detachedId) }, body: { assetId: bondId } });
      expect(res._status).toBe(409);
    });

    it('refuses to attach to another tenant\'s asset', async () => {
      const res = await call(attachHandler, token, { method: 'POST', query: { id: String(detachedId) }, body: { assetId: otherItemId } });
      expect(res._status).toBe(404);
    });

    it('attaches to a free asset and clears the orphan markers', async () => {
      const res = await call(attachHandler, token, { method: 'POST', query: { id: String(detachedId) }, body: { assetId: stockB } });
      expect(res._status).toBe(200);
      expect(res._body.terms.assetId).toBe(stockB);
      expect(res._body.terms.orphanedAt).toBeNull();
    });

    it('discard only works while detached', async () => {
      const attached = await call(discardHandler, token, { method: 'DELETE', query: { id: String(detachedId) } });
      expect(attached._status).toBe(409);

      const row = await prisma.incomeTerms.create({
        data: { tenantId, incomeType: 'INTEREST', apyPct: 4, orphanedAt: new Date(), orphanedLabel: 'Cash USD' },
      });
      const res = await call(discardHandler, token, { method: 'DELETE', query: { id: String(row.id) } });
      expect(res._status).toBe(204);
      expect(await prisma.incomeTerms.findUnique({ where: { id: row.id } })).toBeNull();
    });
  });

  // ─── Projection ──────────────────────────────────────────────────────────

  describe('GET /api/portfolio/passive-income', () => {
    it('rejects an invalid horizon', async () => {
      const res = await call(passiveIncomeHandler, token, { query: { horizon: '18' } });
      expect(res._status).toBe(400);
    });

    it('returns the projection with KPIs, items and streams', async () => {
      const res = await call(passiveIncomeHandler, token, { query: { horizon: '24' } });
      expect(res._status).toBe(200);
      const body = res._body;
      expect(body.displayCurrency).toBe('USD');
      expect(body.projected).toHaveLength(24);
      expect(body.yearly).toHaveLength(2);
      expect(body.actuals).toHaveLength(12);
      expect(body.kpis.next12mOtherIncome).toBeGreaterThan(0); // allowance streams
      expect(body.kpis.next12mInvestmentIncome).toBeGreaterThan(0); // bond + dividend override
      // Crypto is not income-capable; stock + bond count toward coverage.
      expect(body.items.some((i: any) => i.portfolioItemId === cryptoId)).toBe(false);
      const bond = body.items.find((i: any) => i.portfolioItemId === bondId);
      expect(bond.incomeType).toBe('FIXED_COUPON');
      expect(bond.frequency).toBe('SEMIANNUAL');
      expect(bond.endDate).toBe('2030-06-15');
      const override = body.items.find((i: any) => i.portfolioItemId === stockA);
      expect(override.source).toBe('OVERRIDE');
      expect(body.items.filter((i: any) => i.kind === 'STREAM')).toHaveLength(2);
    });
  });

  // ─── Grouped view (#83) ──────────────────────────────────────────────────

  describe('grouped view (#83)', () => {
    const GSYM = `PITEST-GOOG-${SUFFIX}`;
    const BOND = `Government Bonds - PITEST ${SUFFIX}`;
    const CASH = `Cash EUR ${SUFFIX}`;
    let goog1: number;
    let goog2: number;
    let googClosed: number;
    let googOther: number;
    let googManual: number;
    let bond1: number;
    let bond2: number;
    let cash1: number;
    let cash2: number;

    beforeAll(async () => {
      const { countryId, currencyCode, bankId } = await ensureReferenceData();
      const account = (name: string) => prisma.account.create({
        data: { tenantId, name, accountNumber: `PI-${name}-${SUFFIX}`, bankId, countryId, currencyCode },
      });
      const [ibkr, xp, bankA, bankB] = await Promise.all([account('IBKR'), account('XP'), account('Bank A'), account('Bank B')]);
      const cat = (data: any) => prisma.category.create({ data: { tenantId, ...data } });
      const stocks = await cat({ name: 'Stocks #83', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK' });
      const other = await cat({ name: 'Other #83', group: 'Other', type: 'Asset', processingHint: 'MANUAL' });
      const bonds = await cat({ name: 'Bonds #83', group: 'Bonds', type: 'Investments', processingHint: 'MANUAL', defaultCategoryCode: 'CORPORATE_BONDS' });
      const cash = await cat({ name: 'Cash #83', group: 'Cash', type: 'Asset', processingHint: 'CASH' });
      const item = (data: any) => prisma.portfolioItem.create({ data: { tenantId, currency: 'USD', source: 'SYNCED', ...data } });

      goog1 = (await item({ categoryId: stocks.id, symbol: GSYM, accountId: ibkr.id, quantity: 20, currentValue: 4000, currentValueInUSD: 4000 })).id;
      goog2 = (await item({ categoryId: stocks.id, symbol: GSYM, accountId: xp.id, currency: 'BRL', quantity: 15, currentValue: 3000, currentValueInUSD: 3000 })).id;
      // Sold out: not a sibling, not a PUT target.
      googClosed = (await item({ categoryId: stocks.id, symbol: GSYM, accountId: bankA.id, quantity: 0 })).id;
      // Same symbol, different asset class: never part of the group.
      googManual = (await item({ categoryId: other.id, symbol: GSYM, accountId: bankB.id, quantity: 1, currentValue: 10 })).id;
      const otherCat = await prisma.category.create({ data: { tenantId: otherTenantId, name: 'Stocks #83', group: 'Stocks', type: 'Investments', processingHint: 'API_STOCK' } });
      googOther = (await prisma.portfolioItem.create({ data: { tenantId: otherTenantId, categoryId: otherCat.id, symbol: GSYM, currency: 'USD', source: 'SYNCED', quantity: 5 } })).id;

      bond1 = (await item({ categoryId: bonds.id, symbol: BOND, accountId: ibkr.id, source: 'MANUAL', quantity: 10, currentValue: 10000, currentValueInUSD: 10000 })).id;
      bond2 = (await item({ categoryId: bonds.id, symbol: BOND, accountId: xp.id, source: 'MANUAL', quantity: 30, currentValue: 30000, currentValueInUSD: 30000 })).id;
      cash1 = (await item({ categoryId: cash.id, symbol: CASH, accountId: bankA.id, currency: 'EUR', quantity: 5000, currentValue: 5000, currentValueInUSD: 5000 })).id;
      cash2 = (await item({ categoryId: cash.id, symbol: CASH, accountId: bankB.id, currency: 'EUR', quantity: 10000, currentValue: 10000, currentValueInUSD: 10000 })).id;
    });

    it('GET returns open siblings of the same symbol and class, tenant-isolated', async () => {
      const res = await call(incomeTermsHandler, token, { query: { assetId: String(goog1) } });
      expect(res._status).toBe(200);
      const ids = res._body.siblings.map((s: any) => s.assetId).sort();
      expect(ids).toEqual([goog1, goog2].sort());
      expect(ids).not.toContain(googOther);
      expect(ids).not.toContain(googManual);
      expect(ids).not.toContain(googClosed);
      expect(res._body.siblings.find((s: any) => s.assetId === goog2)).toMatchObject({
        accountName: 'XP', quantity: 15, currency: 'BRL', terms: null, source: 'MISSING',
      });
    });

    it('GET on a closed holding still lists it as its own sibling', async () => {
      const res = await call(incomeTermsHandler, token, { query: { assetId: String(googClosed) } });
      expect(res._body.siblings.map((s: any) => s.assetId)).toContain(googClosed);
    });

    it('PUT applyToSymbol writes FIXED_COUPON to every holding of the bond, per unit', async () => {
      const body = { incomeType: 'FIXED_COUPON', faceValuePerUnit: 1000, couponRate: 5, frequency: 'SEMIANNUAL', maturityDate: '2031-06-15', applyToSymbol: true };
      const res = await call(incomeTermsHandler, token, { method: 'PUT', query: { assetId: String(bond1) }, body });
      expect(res._status).toBe(200);
      expect(res._body.appliedTo.sort()).toEqual([bond1, bond2].sort());
      const rows = await prisma.incomeTerms.findMany({ where: { assetId: { in: [bond1, bond2] } } });
      expect(rows.map((r) => Number(r.faceValuePerUnit))).toEqual([1000, 1000]);
    });

    it('PUT applyToSymbol keeps each target\'s own currency and skips other classes, closed holdings and tenants', async () => {
      const res = await call(incomeTermsHandler, token, {
        method: 'PUT',
        query: { assetId: String(goog1) },
        body: { incomeType: 'DIVIDEND', dividendPerUnit: 3, frequency: 'QUARTERLY', applyToSymbol: true },
      });
      expect(res._status).toBe(200);
      expect(res._body.appliedTo.sort()).toEqual([goog1, goog2].sort());
      const rows = await prisma.incomeTerms.findMany({ where: { assetId: { in: [goog1, goog2, googClosed, googManual, googOther] } } });
      expect(rows).toHaveLength(2);
      const byAsset = new Map(rows.map((r) => [r.assetId, r]));
      expect(byAsset.get(goog1)?.currency).toBe('USD');
      expect(byAsset.get(goog2)?.currency).toBe('BRL');
    });

    it('PUT applyToSymbol with INTEREST (cash) is rejected; per-account cash terms still work', async () => {
      const bad = await call(incomeTermsHandler, token, {
        method: 'PUT', query: { assetId: String(cash1) }, body: { incomeType: 'INTEREST', apyPct: 4, applyToSymbol: true },
      });
      expect(bad._status).toBe(400);
      expect(bad._body.error).toBe('Cash interest is set per account');
      const a = await call(incomeTermsHandler, token, { method: 'PUT', query: { assetId: String(cash1) }, body: { incomeType: 'INTEREST', apyPct: 0 } });
      const b = await call(incomeTermsHandler, token, { method: 'PUT', query: { assetId: String(cash2) }, body: { incomeType: 'INTEREST', apyPct: 4 } });
      expect([a._status, b._status]).toEqual([200, 200]);
      expect(b._body.appliedTo).toEqual([cash2]);
    });

    it('GET /passive-income returns groups, missingGroups, grouped upcoming payments and the new item fields', async () => {
      const res = await call(passiveIncomeHandler, token, { query: { horizon: '12' } });
      expect(res._status).toBe(200);
      const body = res._body;
      const goog = body.groups.find((g: any) => g.groupKey === GSYM && g.assetClass === 'STOCK');
      expect(goog).toMatchObject({ kind: 'SECURITY', accountCount: 2, source: 'OVERRIDE', quantity: 35 });
      expect(goog.children.map((c: any) => c.accountName).sort()).toEqual(['IBKR', 'XP']);
      const bond = body.groups.find((g: any) => g.groupKey === BOND);
      expect(bond).toMatchObject({ accountCount: 2, rateOrYield: 0.05, endDate: '2031-06-15' });
      const [b1, b2] = [bond1, bond2].map((id) => body.items.find((i: any) => i.portfolioItemId === id));
      expect(b2.next12mTotal).toBeCloseTo(b1.next12mTotal * 3, 2);
      const cash = body.groups.find((g: any) => g.groupKey === CASH);
      expect(cash).toMatchObject({ kind: 'CASH', accountCount: 2, currentValue: 15000, rateRange: [0, 0.04] });
      // The manual asset sharing the ticker is its own (missing) group.
      expect(body.missingGroups.some((m: any) => m.groupKey === GSYM && m.assetClass === 'OTHER')).toBe(false);
      expect(body.items.find((i: any) => i.portfolioItemId === goog2)).toMatchObject({
        accountName: 'XP', currency: 'BRL', quantity: 15, currentValue: 3000,
      });
      expect(Array.isArray(body.upcomingPaymentsGrouped)).toBe(true);
      const googLines = body.upcomingPaymentsGrouped.filter((u: any) => u.groupKey === GSYM);
      expect(new Set(googLines.map((u: any) => u.date)).size).toBe(googLines.length);
      expect(body.kpis.coverage.total).toBeLessThanOrEqual(body.kpis.coverageByHolding.total);
      expect(body.kpis.coverageByHolding).toBeDefined();
    });

    it('DELETE ?applyToSymbol=true removes the terms from every holding of the symbol', async () => {
      const res = await call(incomeTermsHandler, token, {
        method: 'DELETE', query: { assetId: String(goog2), applyToSymbol: 'true' },
      });
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ deleted: 2 });
      expect(await prisma.incomeTerms.count({ where: { assetId: { in: [goog1, goog2] } } })).toBe(0);
    });

    it('DELETE ?applyToSymbol=true is rejected for cash and 404s for another tenant', async () => {
      const cash = await call(incomeTermsHandler, token, {
        method: 'DELETE', query: { assetId: String(cash1), applyToSymbol: 'true' },
      });
      expect(cash._status).toBe(400);
      const foreign = await call(incomeTermsHandler, otherToken, {
        method: 'DELETE', query: { assetId: String(bond1), applyToSymbol: 'true' },
      });
      expect(foreign._status).toBe(404);
      expect(await prisma.incomeTerms.count({ where: { assetId: { in: [bond1, bond2, cash1] } } })).toBe(3);
    });
  });
});
