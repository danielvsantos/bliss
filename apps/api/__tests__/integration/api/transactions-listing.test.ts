/**
 * Integration tests — a holding takes the listing (exchange / ISIN / asset
 * currency) of its transactions (#134).
 *
 * NVD is Nvidia on Xetra (EUR) and a 2x short NVDA ETF on Nasdaq (USD).
 * Valuation prices a holding by `PortfolioItem.exchange`, so when the app
 * form or MCP created the holding without it, every price lookup went out
 * with the bare symbol and Twelve Data returned the Nasdaq ETF.
 *
 * Real bliss_test Postgres and the real withAuth; events are mocked.
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

async function call(overrides: Record<string, unknown>) {
  const req = {
    url: '/api/transactions', headers: {}, cookies: { token: tenant.token }, body: {}, query: {}, ...overrides,
  } as any;
  const res = makeRes();
  await transactionsHandler(req, res);
  return res;
}

let tenant: IsolatedTenant;
let accountId: number;
let stocksCategoryId: number;

const buy = (overrides: Record<string, unknown> = {}) => ({
  transaction_date: '2026-09-01',
  categoryId: stocksCategoryId,
  accountId,
  description: 'Buy Nvidia',
  debit: 5564.45,
  currency: 'EUR',
  ticker: 'NVD',
  assetQuantity: 44,
  assetPrice: 126.46,
  ...overrides,
});

const holding = (symbol = 'NVD') =>
  prisma.portfolioItem.findFirst({ where: { tenantId: tenant.tenantId, symbol, accountId } });

beforeAll(async () => {
  tenant = await createIsolatedTenant('listing');
  const ref = await ensureReferenceData();
  const category = await prisma.category.create({
    data: {
      name: 'Stocks listing',
      group: 'Stocks',
      type: 'Investments',
      processingHint: 'API_STOCK',
      portfolioItemKeyStrategy: 'TICKER',
      tenantId: tenant.tenantId,
    },
  });
  const account = await prisma.account.create({
    data: {
      name: 'Degiro',
      accountNumber: '0000LIST',
      bankId: ref.bankId,
      countryId: ref.countryId,
      currencyCode: ref.currencyCode,
      tenantId: tenant.tenantId,
    },
  });
  stocksCategoryId = category.id;
  accountId = account.id;
});

afterAll(async () => {
  await teardownTenant(tenant.tenantId);
});

beforeEach(async () => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;
  vi.mocked(produceEvent).mockClear();
  await prisma.transaction.deleteMany({ where: { tenantId: tenant.tenantId } });
  await prisma.portfolioItem.deleteMany({ where: { tenantId: tenant.tenantId } });
});

describe('POST /api/transactions — holding listing (#134)', () => {
  it('creates the holding with the exchange, ISIN and asset currency of the transaction', async () => {
    const res = await call({
      method: 'POST',
      body: buy({ exchange: 'XETR', isin: 'US67066G1040', assetCurrency: 'EUR' }),
    });

    expect(res._status).toBe(201);
    expect(await holding()).toMatchObject({ exchange: 'XETR', isin: 'US67066G1040', assetCurrency: 'EUR' });
  });

  it('sets the exchange on an existing holding that was created without one', async () => {
    expect((await call({ method: 'POST', body: buy() }))._status).toBe(201);
    expect((await holding())?.exchange).toBeNull();

    const res = await call({ method: 'POST', body: buy({ exchange: 'XETR' }) });

    expect(res._status).toBe(201);
    expect((await holding())?.exchange).toBe('XETR');
  });

  it('never clears a known exchange when a later transaction omits it', async () => {
    await call({ method: 'POST', body: buy({ exchange: 'XETR' }) });
    await call({ method: 'POST', body: buy({ debit: 100, assetQuantity: 1 }) });

    expect((await holding())?.exchange).toBe('XETR');
  });
});

describe('PUT /api/transactions — holding listing (#134)', () => {
  it('adding an exchange to an existing transaction updates its holding and triggers revaluation', async () => {
    const created = await call({ method: 'POST', body: buy() });
    const txId = created._body.id;
    expect((await holding())?.exchange).toBeNull();
    vi.mocked(produceEvent).mockClear();

    const res = await call({
      method: 'PUT',
      query: { id: String(txId) },
      body: buy({ exchange: 'XETR', isin: 'US67066G1040', assetCurrency: 'EUR' }),
    });

    expect(res._status).toBe(200);
    const item = await holding();
    expect(item).toMatchObject({ exchange: 'XETR', isin: 'US67066G1040', assetCurrency: 'EUR' });
    expect(res._body.portfolioItemId).toBe(item?.id);
    // The portfolio worker re-processes the holding and revalues its history.
    expect(produceEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'MANUAL_TRANSACTION_MODIFIED',
      portfolioItemId: item?.id,
    }));
  });
});
