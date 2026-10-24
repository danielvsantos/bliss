/**
 * Integration tests for eToro copy trading (#143), against the real bliss_test
 * database:
 *
 *   connections: roles (admin only writes, every role reads), integration keys
 *   denied, write-scope / invalid keys refused with nothing stored, connect →
 *   username + copies, keys encrypted and never returned, duplicate login,
 *   "Sync now" cooldown, key replace (same login only), remove.
 *   convert-holding: in place, transactions + IncomeTerms unchanged, clash.
 *   Equity Analysis: a linked copy is split by sector / country / asset class
 *   from its own holdings, the parts add up to its value, look-through off is
 *   one "Diversified" bucket. Portfolio items carry the link status.
 *
 * withAuth is real. Mocked: rate limiter, produceEvent, Sentry, Redis (fake),
 * the eToro client factory and the live-price lookup.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('../../../../utils/rateLimit.js', () => ({
  rateLimiters: new Proxy({} as Record<string, unknown>, {
    get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
  createRateLimiter: vi.fn().mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

const { mockProduceEvent } = vi.hoisted(() => ({ mockProduceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../../utils/produceEvent.js', () => ({ produceEvent: mockProduceEvent }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), init: vi.fn() }));
vi.mock('../../../../services/valuation.service.js', () => ({ calculateAssetCurrentValue: vi.fn().mockResolvedValue(null) }));

import prisma from '../../../../prisma/prisma.js';
import { EtoroError } from '@bliss/shared/etoro';
import { createIsolatedTenant, teardownTenant } from '../../../helpers/tenant.js';
import { createIntegrationKey, createTenantUser, bearer } from '../../../helpers/integration';
import { ensureReferenceData } from '../../../helpers/referenceData';
import { createFakeRedis } from '../../../helpers/fakeRedis';
import { __setRedisClientForTests } from '../../../../utils/redisClient.js';
import { __setEtoroClientFactoryForTests } from '../../../../utils/etoro.js';

import connectionsHandler from '../../../../pages/api/etoro/connections/index.js';
import connectionHandler from '../../../../pages/api/etoro/connections/[id].js';
import syncHandler from '../../../../pages/api/etoro/connections/[id]/sync.js';
import convertHandler from '../../../../pages/api/etoro/convert-holding.js';
import equityHandler from '../../../../pages/api/portfolio/equity-analysis.js';
import itemsHandler from '../../../../pages/api/portfolio/items.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeReq(opts: { token?: string | null; headers?: Record<string, string> } & Partial<NextApiRequest> = {}): NextApiRequest {
  const { token = null, headers = {}, ...overrides } = opts;
  return {
    method: 'GET', headers, cookies: token ? { token } : {}, body: {}, query: {}, url: '/api/etoro/connections', ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes() {
  const res: any = { _status: undefined, _body: undefined, _headers: {} };
  res.status = vi.fn((c: number) => { res._status = c; return res; });
  res.json = vi.fn((b: unknown) => { res._body = b; return res; });
  res.setHeader = vi.fn((k: string, v: unknown) => { res._headers[k] = v; return res; });
  res.end = vi.fn(() => res);
  return res;
}

const bodies: unknown[] = [];
async function call(handler: any, req: NextApiRequest) {
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  bodies.push(res._body);
  return res;
}

// Unique symbols: SecurityMaster is global, so the fixtures must not collide.
const S = `ZQ${Date.now().toString(36).toUpperCase()}`;
const SYM = { tech: `${S}T`, health: `${S}H`, fr: `${S}F`, etf: `${S}E` };
const INVESTOR = `topinv${Date.now().toString(36)}`;

/** A fake eToro account: identity, scopes and one copy of INVESTOR. */
function account({ cid = '1001', username = 'BlissUser', scopes = ['trade.real:read', 'crypto:read'] } = {}) {
  return {
    getMe: vi.fn(async () => ({ cid, username, scopes })),
    getAggregatePortfolio: vi.fn(async () => ({
      accountCurrency: 'USD',
      mirrors: [{ mirrorId: 9, mirrorTotals: { mirrorLiquidationValue: 2500 }, mirrorAvailableCash: 100, instrumentAggregates: [] }],
    })),
    getPortfolio: vi.fn(async () => ({
      clientPortfolio: { mirrors: [{ mirrorID: 9, parentUsername: INVESTOR, startedCopyDate: '2026-03-01T00:00:00Z' }] },
    })),
    getInstruments: vi.fn(async () => new Map()),
  };
}

const KEYS = { apiKey: 'PUB-KEY-ABCD-1234', userKey: 'PRIVATE-USER-KEY-SECRET' };
const accountsByKey = new Map<string, ReturnType<typeof account>>();

let admin: { tenantId: string; userId: string; token: string };
let memberToken: string;
let viewerToken: string;
let ref: { bankId: number; countryId: string; currencyCode: string };
let etoroAccountId: number;

const connectReq = (body: Record<string, unknown>, token = admin.token) =>
  call(connectionsHandler, makeReq({ token, method: 'POST', body }));

beforeAll(async () => {
  admin = await createIsolatedTenant('etoro');
  memberToken = (await createTenantUser(admin.tenantId, 'member')).token;
  viewerToken = (await createTenantUser(admin.tenantId, 'viewer')).token;
  ref = await ensureReferenceData({ countryId: 'USA', currencyCode: 'USD' });
  etoroAccountId = (await prisma.account.create({
    data: { name: 'eToro', accountNumber: 'ETORO-1', bankId: ref.bankId, countryId: ref.countryId, currencyCode: 'USD', tenantId: admin.tenantId },
  })).id;
  __setRedisClientForTests(createFakeRedis() as never);
  __setEtoroClientFactoryForTests(({ apiKey }: { apiKey: string }) => accountsByKey.get(apiKey) || account());
});

afterAll(async () => {
  __setEtoroClientFactoryForTests(null);
  __setRedisClientForTests(null as never);
  await prisma.securityMaster.deleteMany({ where: { symbol: { in: Object.values(SYM) } } });
  await teardownTenant(admin.tenantId);
  await prisma.$disconnect();
});

beforeEach(() => {
  mockProduceEvent.mockClear();
  accountsByKey.clear();
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('eToro connections', () => {
  let connectionId: string;

  it('lists nothing yet, for every role', async () => {
    for (const token of [admin.token, memberToken, viewerToken]) {
      const res = await call(connectionsHandler, makeReq({ token }));
      expect(res._status).toBe(200);
      expect(res._body.connections).toEqual([]);
    }
  });

  it('only admins can add a key', async () => {
    for (const token of [memberToken, viewerToken]) {
      const res = await connectReq({ ...KEYS, accountId: etoroAccountId }, token);
      expect(res._status).toBe(403);
    }
    expect(await prisma.etoroConnection.count({ where: { tenantId: admin.tenantId } })).toBe(0);
  });

  it('integration keys never reach the routes', async () => {
    const { token } = await createIntegrationKey(admin, { accessLevel: 'READ_WRITE' });
    const res = await call(connectionsHandler, makeReq({ headers: bearer(token), method: 'GET', url: '/api/etoro/connections' }));
    expect(res._status).toBe(403);
    expect(res._body.code).toBe('NOT_AVAILABLE_TO_INTEGRATIONS');
  });

  it('refuses a key with a write scope and stores nothing', async () => {
    accountsByKey.set('WRITE-KEY', account({ scopes: ['trade.real:read', 'trade.real:write'] }));
    const res = await connectReq({ apiKey: 'WRITE-KEY', userKey: 'u', accountId: etoroAccountId });
    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ code: 'ETORO_WRITE_SCOPE', writeScopes: ['trade.real:write'] });
    expect(await prisma.etoroConnection.count({ where: { tenantId: admin.tenantId } })).toBe(0);
  });

  it('refuses a key eToro rejects, and validates the body', async () => {
    const bad = account();
    bad.getMe.mockRejectedValue(new EtoroError('KEY_INVALID', 'nope', { status: 401 }));
    accountsByKey.set('BAD-KEY', bad);
    expect((await connectReq({ apiKey: 'BAD-KEY', userKey: 'u', accountId: etoroAccountId }))._body.code).toBe('ETORO_KEY_INVALID');
    expect((await connectReq({ apiKey: 'x', accountId: etoroAccountId }))._body.code).toBe('KEYS_REQUIRED');
    expect((await connectReq({ ...KEYS }))._body.code).toBe('ACCOUNT_REQUIRED');
    expect((await connectReq({ ...KEYS, accountId: 999999999 }))._body.code).toBe('ACCOUNT_NOT_FOUND');
    const down = account();
    down.getMe.mockRejectedValue(new EtoroError('UNAVAILABLE', 'timeout'));
    accountsByKey.set('DOWN-KEY', down);
    expect((await connectReq({ apiKey: 'DOWN-KEY', userKey: 'u', accountId: etoroAccountId }))._status).toBe(502);
    expect(await prisma.etoroConnection.count({ where: { tenantId: admin.tenantId } })).toBe(0);
  });

  it('connects a read key: shows the username and the copies, starts a sync', async () => {
    const res = await connectReq({ ...KEYS, accountId: etoroAccountId });
    expect(res._status).toBe(201);
    expect(res._body.connection).toMatchObject({
      etoroUsername: 'BlissUser', accountId: etoroAccountId, keyLast4: '1234', status: 'ACTIVE', scopes: ['trade.real:read', 'crypto:read'],
    });
    expect(res._body.copies).toEqual([
      { parentUsername: INVESTOR, startedAt: '2026-03-01T00:00:00.000Z', value: 2500, currency: 'USD' },
    ].map((c) => ({ ...c, startedAt: new Date(c.startedAt) })));
    connectionId = res._body.connection.id;
    expect(mockProduceEvent).toHaveBeenCalledWith({ type: 'ETORO_SYNC', tenantId: admin.tenantId, connectionId, source: 'CONNECT' });
  });

  it('stores the keys encrypted and never returns them', async () => {
    const [raw] = await prisma.$queryRaw<Array<{ apiKey: string; userKey: string }>>`
      SELECT "apiKey", "userKey" FROM "EtoroConnection" WHERE id = ${connectionId}`;
    expect(raw.apiKey).not.toContain('PUB-KEY');
    expect(raw.userKey).not.toContain('PRIVATE-USER-KEY');
    const decrypted = await prisma.etoroConnection.findUnique({ where: { id: connectionId } });
    expect(decrypted?.userKey).toBe(KEYS.userKey);

    const list = await call(connectionsHandler, makeReq({ token: viewerToken }));
    expect(list._body.connections).toHaveLength(1);
    expect(JSON.stringify(bodies)).not.toMatch(/PRIVATE-USER-KEY|PUB-KEY-ABCD/);
  });

  it('the same eToro login can\'t be added twice', async () => {
    const res = await connectReq({ ...KEYS, accountId: etoroAccountId });
    expect(res._status).toBe(409);
    expect(res._body).toMatchObject({ code: 'ETORO_ALREADY_CONNECTED', connectionId });
  });

  it('"Sync now" is admin only and has a 15-minute cooldown', async () => {
    const req = (token: string) => makeReq({ token, method: 'POST', query: { id: connectionId }, url: `/api/etoro/connections/${connectionId}/sync` });
    expect((await call(syncHandler, req(memberToken)))._status).toBe(403);
    expect((await call(syncHandler, req(admin.token)))._status).toBe(202);
    expect(mockProduceEvent).toHaveBeenCalledWith({ type: 'ETORO_SYNC', tenantId: admin.tenantId, connectionId, source: 'MANUAL' });
    const again = await call(syncHandler, req(admin.token));
    expect(again._status).toBe(429);
    expect(again._body).toMatchObject({ code: 'COOLDOWN', retryAfter: expect.any(Number) });
  });

  it('replaces an expired key for the same login only', async () => {
    await prisma.etoroConnection.update({ where: { id: connectionId }, data: { status: 'NEEDS_RECONNECT', errorCode: 'KEY_INVALID' } });
    const put = (body: Record<string, unknown>) => call(connectionHandler, makeReq({ token: admin.token, method: 'PUT', query: { id: connectionId }, body }));

    accountsByKey.set('OTHER-LOGIN', account({ cid: '2002' }));
    const other = await put({ apiKey: 'OTHER-LOGIN', userKey: 'u2' });
    expect(other._status).toBe(409);
    expect(other._body.code).toBe('ETORO_DIFFERENT_LOGIN');

    accountsByKey.set('NEW-KEY-9876', account());
    const ok = await put({ apiKey: 'NEW-KEY-9876', userKey: 'new-user-key' });
    expect(ok._status).toBe(200);
    expect(ok._body.connection).toMatchObject({ status: 'ACTIVE', errorCode: null, keyLast4: '9876' });
    expect((await prisma.etoroConnection.findUnique({ where: { id: connectionId } }))?.userKey).toBe('new-user-key');
    expect((await put({}))._body.code).toBe('NOTHING_TO_UPDATE');
  });

  it('members can\'t change or remove a connection', async () => {
    const res = await call(connectionHandler, makeReq({ token: memberToken, method: 'DELETE', query: { id: connectionId } }));
    expect(res._status).toBe(403);
  });

  it('removing stops updates, wipes the keys and keeps the copies', async () => {
    const copy = await prisma.etoroCopy.create({
      data: { tenantId: admin.tenantId, connectionId, mirrorId: 'keep-me', parentUsername: 'someone' },
    });
    const res = await call(connectionHandler, makeReq({ token: admin.token, method: 'DELETE', query: { id: connectionId } }));
    expect(res._status).toBe(204);
    const row = await prisma.etoroConnection.findUnique({ where: { id: connectionId } });
    expect(row).toMatchObject({ status: 'REMOVED', apiKey: '', userKey: '' });
    expect(await prisma.etoroCopy.findUnique({ where: { id: copy.id } })).not.toBeNull();
    expect((await call(connectionsHandler, makeReq({ token: admin.token })))._body.connections).toEqual([]);

    // Connecting the same login again reactivates the connection with its history.
    const again = await connectReq({ ...KEYS, accountId: etoroAccountId });
    expect(again._status).toBe(200);
    expect(again._body.connection.id).toBe(connectionId);
    await prisma.etoroCopy.delete({ where: { id: copy.id } });
  });
});

// ---------------------------------------------------------------------------
// Convert a manual Fund to Copy Trading (R8)
// ---------------------------------------------------------------------------

describe('POST /api/etoro/convert-holding', () => {
  let fundItemId: number;
  let copyCategoryId: number;

  beforeAll(async () => {
    const funds = await prisma.category.create({
      data: { name: 'Funds', group: 'Funds', type: 'Investments', tenantId: admin.tenantId, processingHint: 'API_FUND', portfolioItemKeyStrategy: 'TICKER', defaultCategoryCode: 'INVESTMENT_FUNDS' },
    });
    copyCategoryId = (await prisma.category.create({
      data: { name: 'Copy Trading', group: 'Funds', type: 'Investments', tenantId: admin.tenantId, processingHint: 'COPY_TRADING', portfolioItemKeyStrategy: 'TICKER', defaultCategoryCode: 'COPY_TRADING' },
    })).id;
    const item = await prisma.portfolioItem.create({
      data: { tenantId: admin.tenantId, categoryId: funds.id, accountId: etoroAccountId, symbol: 'Funds:Copy of TopInvestor', currency: 'USD', source: 'MANUAL', quantity: 1, currentValue: 1000, currentValueInUSD: 1000 },
    });
    fundItemId = item.id;
    await prisma.transaction.create({
      data: {
        transaction_date: new Date('2026-03-02T00:00:00Z'), year: 2026, quarter: 'Q1', month: 3, day: 2,
        categoryId: funds.id, description: 'Copy of TopInvestor', debit: 1000, currency: 'USD', accountId: etoroAccountId,
        assetQuantity: 1, assetPrice: 1000, tenantId: admin.tenantId, portfolioItemId: item.id,
      },
    });
    await prisma.incomeTerms.create({ data: { tenantId: admin.tenantId, assetId: item.id, incomeType: 'NONE', currency: 'USD' } });
  });

  const convert = (body: Record<string, unknown>, token = admin.token) =>
    call(convertHandler, makeReq({ token, method: 'POST', body, url: '/api/etoro/convert-holding' }));

  it('viewers can\'t convert; bad input is refused', async () => {
    expect((await convert({ portfolioItemId: fundItemId, etoroUsername: INVESTOR }, viewerToken))._status).toBe(403);
    expect((await convert({ portfolioItemId: fundItemId, etoroUsername: '!' }))._body.code).toBe('INVALID_USERNAME');
    expect((await convert({ etoroUsername: INVESTOR }))._body.code).toBe('PORTFOLIO_ITEM_REQUIRED');
  });

  it('switches the holding in place: same id, transactions and income terms unchanged', async () => {
    const before = await prisma.transaction.findMany({ where: { portfolioItemId: fundItemId }, orderBy: { id: 'asc' } });
    const res = await convert({ portfolioItemId: fundItemId, etoroUsername: `@${INVESTOR.toUpperCase()}` }, memberToken);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ portfolioItemId: fundItemId, symbol: INVESTOR, categoryId: copyCategoryId, transactionsMoved: 1 });

    const item = await prisma.portfolioItem.findUnique({ where: { id: fundItemId }, include: { incomeTerms: true } });
    expect(item).toMatchObject({ categoryId: copyCategoryId, symbol: INVESTOR, source: 'SYNCED' });
    expect(item?.incomeTerms).not.toBeNull();
    const after = await prisma.transaction.findMany({ where: { portfolioItemId: fundItemId }, orderBy: { id: 'asc' } });
    expect(after.map((t) => [t.id, Number(t.debit), t.transaction_date.toISOString(), t.description]))
      .toEqual(before.map((t) => [t.id, Number(t.debit), t.transaction_date.toISOString(), t.description]));
    expect(after.every((t) => t.categoryId === copyCategoryId && t.ticker === INVESTOR)).toBe(true);
    expect(mockProduceEvent).toHaveBeenCalledWith({ type: 'MANUAL_PORTFOLIO_PRICE_UPDATED', tenantId: admin.tenantId, portfolioItemId: fundItemId });
    // Same group (Funds): analytics need no rebuild.
    expect(mockProduceEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CATEGORY_CLASSIFICATION_CHANGED' }));
  });

  it('refuses a second conversion and a clash with an existing copy holding', async () => {
    expect((await convert({ portfolioItemId: fundItemId, etoroUsername: INVESTOR }))._body.code).toBe('ALREADY_COPY_TRADING');
    const other = await prisma.portfolioItem.create({
      data: { tenantId: admin.tenantId, categoryId: (await prisma.category.findFirstOrThrow({ where: { tenantId: admin.tenantId, name: 'Funds' } })).id, accountId: etoroAccountId, symbol: 'Funds:Other', currency: 'USD', source: 'MANUAL' },
    });
    const clash = await convert({ portfolioItemId: other.id, etoroUsername: INVESTOR });
    expect(clash._status).toBe(409);
    expect(clash._body).toMatchObject({ code: 'COPY_HOLDING_EXISTS', portfolioItemId: fundItemId });
    await prisma.portfolioItem.delete({ where: { id: other.id } });
  });
});

// ---------------------------------------------------------------------------
// Equity Analysis look-through of a linked copy (R13–R17)
// ---------------------------------------------------------------------------

describe('Equity Analysis with a linked copy', () => {
  beforeAll(async () => {
    await prisma.securityMaster.createMany({
      data: [
        { symbol: SYM.tech, assetType: 'Common Stock', sector: 'Technology', country: 'United States', peRatio: 30, earningsTrusted: true, dividendYield: 0.01, dividendTrusted: true },
        { symbol: SYM.health, assetType: 'Common Stock', sector: 'Healthcare', country: 'United States', peRatio: 20, earningsTrusted: true },
        { symbol: SYM.fr, assetType: 'Common Stock', sector: 'Industrials', country: 'France' },
        {
          symbol: SYM.etf, assetType: 'ETF', name: 'World ETF',
          etfComposition: { sectors: [{ sector: 'Technology', weight: 0.5 }, { sector: 'Financial Services', weight: 0.5 }], countries: [{ country: 'United States', weight: 0.6 }, { country: 'Japan', weight: 0.4 }], assetAllocation: { stocks: 1 } },
        },
      ],
    });
    const connection = await prisma.etoroConnection.findFirstOrThrow({ where: { tenantId: admin.tenantId } });
    await prisma.etoroCopy.create({
      data: {
        tenantId: admin.tenantId, connectionId: connection.id, mirrorId: '9', parentUsername: INVESTOR, status: 'ACTIVE',
        lastValue: 1000, lastValueAt: new Date(), cashPct: 5, unmappedPct: 0,
        holdings: [
          { instrumentId: 1, etoroSymbol: SYM.tech, symbol: SYM.tech, exchange: 'XNAS', type: 'STOCK', valuePct: 30 },
          { instrumentId: 2, etoroSymbol: `${SYM.tech}.RTH`, symbol: SYM.tech, exchange: null, usVariant: true, type: 'STOCK', valuePct: 10 },
          { instrumentId: 3, etoroSymbol: SYM.health, symbol: SYM.health, exchange: 'XNYS', type: 'STOCK', valuePct: 20 },
          { instrumentId: 4, etoroSymbol: `${SYM.fr}.PA`, symbol: SYM.fr, exchange: 'XPAR', type: 'STOCK', valuePct: 15 },
          { instrumentId: 5, etoroSymbol: SYM.etf, symbol: SYM.etf, exchange: 'XNAS', type: 'ETF', valuePct: 20 },
        ],
      },
    });
  });

  const equity = (query: Record<string, string>) =>
    call(equityHandler, makeReq({ token: admin.token, query, url: '/api/portfolio/equity-analysis' }));
  const groupValue = (body: any, name: string) =>
    body.groups.find((g: any) => g.name === name)?.totalValue ?? 0;

  it('splits the copy across sectors from its own holdings; the parts add up to its value', async () => {
    const res = await equity({ groupBy: 'sector' });
    expect(res._status).toBe(200);
    const copy = res._body.copies.find((h: any) => h.symbol === INVESTOR);
    expect(copy).toMatchObject({
      assetType: 'COPY_TRADE', assetClass: 'COPY_TRADE', currentValue: 1000,
      copyTrade: { linked: true, status: 'ACTIVE', connectionStatus: 'ACTIVE' },
      sectorCoveragePct: 95,
    });
    // AMZN-style RTH line merged into the plain listing: 30 + 10.
    expect(groupValue(res._body, 'Technology')).toBeCloseTo(1000 * (0.40 + 0.20 * 0.5));
    expect(groupValue(res._body, 'Healthcare')).toBeCloseTo(200);
    expect(groupValue(res._body, 'Industrials')).toBeCloseTo(150);
    expect(groupValue(res._body, 'Financial Services')).toBeCloseTo(100);
    const total = res._body.groups.reduce((s: number, g: any) => s + g.totalValue, 0);
    expect(total).toBeCloseTo(1000, 0);
    const unknown = ['Unknown', 'Diversified', 'Other'].reduce((s, n) => s + groupValue(res._body, n), 0);
    expect(unknown / 1000).toBeLessThanOrEqual(0.10); // PRD outcome metric
  });

  it('shows the copy as its own positions when looking through, and as one row otherwise', async () => {
    const on = await equity({ groupBy: 'sector' });
    expect(on._body.holdings.some((h: any) => h.assetType === 'COPY_TRADE')).toBe(false);
    const via = on._body.holdings.filter((h: any) => h.viaCopy?.username === INVESTOR);
    // tech (30 + 10 RTH merged), health, fr, etf, cash
    expect(via).toHaveLength(5);
    const tech = via.find((h: any) => h.symbol === SYM.tech);
    expect(tech).toMatchObject({ assetType: 'STOCK', assetClass: 'STOCK', sector: 'Technology', peRatio: 30, itemIds: [] });
    expect(tech.currentValue).toBeCloseTo(400);
    expect(via.find((h: any) => h.symbol === SYM.etf)).toMatchObject({ assetType: 'ETF', sector: 'Diversified' });
    expect(via.find((h: any) => h.viaCopy.kind === 'CASH')).toMatchObject({ symbol: 'CASH', assetClass: 'CASH', sector: 'Other' });
    expect(via.reduce((s: number, h: any) => s + h.currentValue, 0)).toBeCloseTo(1000);
    expect(new Set(via.map((h: any) => h.key)).size).toBe(5);

    const off = await equity({ groupBy: 'sector', lookThrough: 'false' });
    expect(off._body.holdings.filter((h: any) => h.viaCopy)).toHaveLength(0);
    expect(off._body.holdings.find((h: any) => h.symbol === INVESTOR)).toMatchObject({ assetType: 'COPY_TRADE' });
    expect(off._body.copies).toHaveLength(1);
  });

  it('splits it across countries too', async () => {
    const res = await equity({ groupBy: 'country' });
    expect(groupValue(res._body, 'United States')).toBeCloseTo(1000 * (0.40 + 0.20 + 0.20 * 0.6));
    expect(groupValue(res._body, 'France')).toBeCloseTo(150);
    expect(groupValue(res._body, 'Japan')).toBeCloseTo(80);
  });

  it('shows the copy\'s asset-class mix, and one COPY_TRADE row with look-through off', async () => {
    const on = await equity({ groupBy: 'assetClass' });
    expect(groupValue(on._body, 'STOCK')).toBeCloseTo(750);
    expect(groupValue(on._body, 'INDEX_ETF')).toBeCloseTo(200);
    expect(groupValue(on._body, 'CASH')).toBeCloseTo(50);
    const off = await equity({ groupBy: 'assetClass', lookThrough: 'false' });
    expect(groupValue(off._body, 'COPY_TRADE')).toBeCloseTo(1000);
  });

  it('is one "Diversified" bucket with look-through off', async () => {
    const res = await equity({ groupBy: 'sector', lookThrough: 'false' });
    expect(groupValue(res._body, 'Diversified')).toBeCloseTo(1000);
  });

  it('labels P/E and yield with the share of value they are based on (R17)', async () => {
    const res = await equity({ groupBy: 'sector' });
    const copy = res._body.copies.find((h: any) => h.symbol === INVESTOR);
    // Tech 40% @30, Health 20% @20 → 26.67 over 60% of the copy.
    expect(copy.peRatio).toBeCloseTo(26.67, 1);
    expect(copy.peCoverage).toBe(60);
    expect(copy.dividendYield).toBeCloseTo(0.01);
    expect(copy.yieldCoverage).toBe(40);
    expect(res._body.summary.copyTradeCount).toBe(1);
    // The split rows give the same portfolio P/E as the copy's coverage-weighted one.
    const off = await equity({ groupBy: 'sector', lookThrough: 'false' });
    expect(res._body.summary.weightedPeRatio).toBeCloseTo(off._body.summary.weightedPeRatio, 1);
    expect(res._body.summary.weightedDividendYield).toBeCloseTo(off._body.summary.weightedDividendYield, 4);
  });

  it('portfolio items carry the link status for badges', async () => {
    const res = await call(itemsHandler, makeReq({ token: admin.token, url: '/api/portfolio/items' }));
    const copy = res._body.items.find((i: any) => i.symbol === INVESTOR);
    expect(copy.copyTrade).toMatchObject({ linked: true, status: 'ACTIVE', connectionStatus: 'ACTIVE' });
  });

  it('an unlinked Copy Trading holding stays "Diversified" with linked: false', async () => {
    await prisma.etoroCopy.updateMany({ where: { tenantId: admin.tenantId, parentUsername: INVESTOR }, data: { parentUsername: 'somebody-else' } });
    const res = await equity({ groupBy: 'sector' });
    const copy = res._body.holdings.find((h: any) => h.symbol === INVESTOR);
    expect(copy.copyTrade).toEqual({ linked: false });
    expect(groupValue(res._body, 'Diversified')).toBeCloseTo(1000);
  });
});
