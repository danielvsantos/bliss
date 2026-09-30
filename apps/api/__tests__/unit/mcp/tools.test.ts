/**
 * Unit tests — MCP tool → REST mapping (#89).
 *
 * Every tool runs against a fake loopback client keyed by `METHOD path`, so
 * each test pins the exact REST call(s) a tool makes and the shape it returns.
 * The integration suites (__tests__/integration/api/mcp) run the same tools
 * against the real handlers.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { getTool, ALL_TOOLS } from '../../../lib/mcp/registry.js';
import { LoopbackError } from '../../../lib/mcp/loopback.js';
import { encodeCursor } from '../../../lib/mcp/shape.js';
import { periodQuery } from '../../../lib/mcp/tools/analytics.js';

type Responder = unknown | ((opts: any) => unknown);

function fakeApi(routes: Record<string, Responder>) {
  const calls: Array<{ method: string; path: string; query?: any; body?: any }> = [];
  const call = vi.fn(async (method: string, path: string, { query, body }: any = {}) => {
    calls.push({ method, path, query, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new LoopbackError({ status: 404, error: `No fake for ${key}`, method, route: path });
    const r = routes[key];
    const value = typeof r === 'function' ? (r as any)({ query, body }) : r;
    if (value instanceof Error) throw value;
    return value;
  });
  return {
    calls,
    api: {
      calls: [],
      call,
      get: (p: string, query?: any) => call('GET', p, { query }),
      post: (p: string, body?: any, query?: any) => call('POST', p, { body, query }),
      put: (p: string, body?: any, query?: any) => call('PUT', p, { body, query }),
      del: (p: string, query?: any) => call('DELETE', p, { query }),
    },
  };
}

async function run(name: string, args: Record<string, unknown>, routes: Record<string, Responder>) {
  const tool = getTool(name)!;
  const parsed = z.object(tool.input).parse(args);
  const { api, calls } = fakeApi(routes);
  const result = await tool.handler(parsed, { api });
  return { result, calls };
}

const notFound = (route = '/x') => new LoopbackError({ status: 404, error: 'Not found', method: 'GET', route });

describe('input schemas', () => {
  it('every tool input is a valid zod shape and accepts its minimal call', () => {
    for (const t of ALL_TOOLS) expect(() => z.object(t.input)).not.toThrow();
  });

  it('update_subscription rejects fullScan (AC9)', () => {
    const schema = z.object(getTool('update_subscription')!.input);
    expect(schema.safeParse({ action: 'fullScan' }).success).toBe(false);
    expect(schema.safeParse({ action: 'refresh' }).success).toBe(true);
  });

  it('IDs placed in URL paths only accept ID characters', () => {
    const imports = z.object(getTool('list_imports')!.input);
    expect(imports.safeParse({ importId: 'ckabc123_-X' }).success).toBe(true);
    for (const bad of ['..', '../users', 'a/b', 'a%2Fb', 'a.b', '']) {
      expect(imports.safeParse({ importId: bad }).success, bad).toBe(false);
    }
    const review = z.object(getTool('review_plaid_transactions')!.input);
    expect(review.safeParse({ items: [{ id: '../x', action: 'skip' }] }).success).toBe(false);
    const values = z.object(getTool('manage_manual_values')!.input);
    expect(values.safeParse({ assetId: 1, action: 'delete', valueId: '..' }).success).toBe(false);
  });

  it('limits are capped at 100 and dates must be YYYY-MM-DD', () => {
    const schema = z.object(getTool('search_transactions')!.input);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ from: '01/02/2026' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-02-01', limit: 100 }).success).toBe(true);
  });
});

describe('reference tools', () => {
  it('list_accounts maps pages and masks account numbers', async () => {
    const { result, calls } = await run('list_accounts', { cursor: encodeCursor({ page: 2 }), limit: 1 }, {
      'GET /api/accounts': { accounts: [{ id: 1, name: 'Main', accountNumber: 'DE001234', currencyCode: 'EUR', bank: { name: 'B' }, country: { name: 'Germany' }, plaidAccountId: 'p' }], total: 3 },
    });
    expect(calls[0].query).toMatchObject({ page: 2, limit: 1 });
    expect(result).toEqual({
      items: [{ id: 1, name: 'Main', bank: 'B', currency: 'EUR', country: 'Germany', accountNumberLast4: '1234', linkedToPlaid: true }],
      total: 3, hasMore: true, nextCursor: encodeCursor({ page: 3 }),
    });
  });

  it('list_categories passes filters', async () => {
    const { result, calls } = await run('list_categories', { group: 'Food' }, {
      'GET /api/categories': { categories: [{ id: 5, name: 'Groceries', group: 'Food', type: 'Essentials', _count: { transactions: 9 } }], total: 1 },
    });
    expect(calls[0].query).toMatchObject({ group: 'Food', page: 1, limit: 100 });
    expect(result.items[0]).toMatchObject({ id: 5, transactionCount: 9, isRecurring: false });
  });

  it('get_reference_data defaults to tenant and fans out in parallel', async () => {
    const { result, calls } = await run('get_reference_data', {}, {
      'GET /api/tenants': [{ name: 'Home', currencies: [{ id: 'EUR', name: 'Euro', isDefault: true }], countries: [], transactionYears: [2026, 2025] }],
      'GET /api/tenants/settings': { portfolioCurrency: 'EUR', autoPromoteThreshold: '0.9', reviewThreshold: 0.7 },
    });
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/tenants', '/api/tenants/settings']);
    expect(result).toEqual({
      tenant: {
        name: 'Home', displayCurrency: 'EUR', currencies: [{ id: 'EUR', name: 'Euro', isDefault: true }], countries: [],
        transactionYears: [2026, 2025], autoPromoteThreshold: 0.9, reviewThreshold: 0.7,
      },
    });
  });

  it('get_reference_data lists, search and FX rates', async () => {
    const { result, calls } = await run('get_reference_data', { kinds: ['banks', 'countries', 'currencies', 'fxRates'], search: 'eu', fxDate: '2026-03-04', fxFrom: 'USD' }, {
      'GET /api/banks': [{ id: 1, name: 'Deutsche' }, { id: 2, name: 'Chase' }],
      'GET /api/countries': [{ id: 'DEU', name: 'Germany' }, { id: 'EUR', name: 'x' }],
      'GET /api/currencies': [{ id: 'EUR', name: 'Euro' }, { id: 'USD', name: 'Dollar' }],
      'GET /api/currency-rates': [{ currencyFrom: 'USD', currencyTo: 'EUR', value: '0.91' }],
    });
    expect(result.banks.items).toEqual([{ id: 1, name: 'Deutsche' }]);
    expect(result.currencies.items).toEqual([{ id: 'EUR', name: 'Euro', symbol: null }]);
    expect(result.fxRates.items).toEqual([{ date: '2026-03-04', from: 'USD', to: 'EUR', rate: 0.91 }]);
    expect(calls.find((c) => c.path === '/api/currency-rates')!.query).toMatchObject({ year: 2026, month: 3, day: 4, currencyFrom: 'USD' });
  });

  it('get_reference_data requires fxDate for fxRates', async () => {
    await expect(run('get_reference_data', { kinds: ['fxRates'] }, {})).rejects.toThrow(/fxDate/);
  });

  it('search_ticker and list_tags', async () => {
    const t = await run('search_ticker', { query: ' vwce ', limit: 1 }, { 'GET /api/ticker/search': { results: [{ symbol: 'VWCE' }, { symbol: 'X' }] } });
    expect(t.calls[0].query).toEqual({ q: ' vwce ', type: undefined });
    expect(t.result).toEqual({ items: [{ symbol: 'VWCE' }], total: 2 });
    const tags = await run('list_tags', { limit: 1 }, { 'GET /api/tags': { tags: [{ id: 1, name: 'Japan', budget: '100', startDate: '2026-01-01T00:00:00Z' }], total: 2 } });
    expect(tags.calls[0].query).toEqual({ limit: 1, offset: 0 });
    expect(tags.result).toMatchObject({ items: [{ id: 1, budget: 100, startDate: '2026-01-01' }], hasMore: true });
  });

  it('manage_tags create / update / delete', async () => {
    const routes = {
      'POST /api/tags': ({ body }: any) => ({ id: 7, ...body }),
      'PUT /api/tags': ({ body }: any) => ({ id: 7, name: 'x', ...body }),
      'DELETE /api/tags': null,
    };
    expect((await run('manage_tags', { action: 'create', name: 'Trip' }, routes)).result.created).toMatchObject({ id: 7, name: 'Trip' });
    const upd = await run('manage_tags', { action: 'update', tagId: 7, name: 'Trip 2', budget: null }, routes);
    expect(upd.calls[0]).toMatchObject({ method: 'PUT', query: { id: 7 }, body: { name: 'Trip 2', budget: null } });
    expect((await run('manage_tags', { action: 'delete', tagId: 7 }, routes)).result).toEqual({ deleted: 7 });
    await expect(run('manage_tags', { action: 'create' }, routes)).rejects.toThrow(/name/);
    await expect(run('manage_tags', { action: 'delete' }, routes)).rejects.toThrow(/tagId/);
    await expect(run('manage_tags', { action: 'update', tagId: 7 }, routes)).rejects.toThrow(/at least one/);
  });
});

describe('transaction tools', () => {
  const restTx = {
    id: 9, transaction_date: '2026-02-10T00:00:00.000Z', description: 'Shop', details: null, debit: '30', credit: null,
    currency: 'EUR', accountId: 1, account: { name: 'Main' }, categoryId: 5, category: { name: 'Groceries', group: 'Food', type: 'Essentials' },
    tags: [{ id: 1, name: 'Trip' }], source: 'MANUAL', ticker: null, assetQuantity: null, assetPrice: null,
  };

  it('search_transactions maps filters, signs amounts and pages', async () => {
    const { result, calls } = await run('search_transactions', {
      from: '2026-01-01', to: '2026-01-31', categoryGroup: 'Food', categoryType: 'Essentials', tag: 'Trip', currency: 'EUR', limit: 1,
    }, {
      'GET /api/transactions': { transactions: [restTx], total: 2, totals: { credit: '0', debit: '30', balance: '-30' } },
    });
    expect(calls[0].query).toMatchObject({ startDate: '2026-01-01', endDate: '2026-01-31', group: 'Food', type: 'Essentials', tags: 'Trip', currencyCode: 'EUR', page: 1, limit: 1 });
    expect(result.items[0]).toEqual({
      id: 9, date: '2026-02-10', description: 'Shop', details: null, amount: { value: -30, currency: 'EUR' },
      account: { id: 1, name: 'Main' }, category: { id: 5, name: 'Groceries', group: 'Food', type: 'Essentials' }, tags: ['Trip'], source: 'MANUAL',
    });
    expect(result).toMatchObject({ hasMore: true, totals: { in: 0, out: 30, net: -30, currency: 'EUR' } });
  });

  it('get_merchant_history', async () => {
    const { result } = await run('get_merchant_history', { description: 'netflix' }, {
      'GET /api/transactions/merchant-history': [{ id: 3, transaction_date: '2026-01-02', description: 'NETFLIX', debit: 9.99, credit: null, currency: 'USD', category: { id: 2, name: 'Streaming', group: 'Fun' } }],
    });
    expect(result.items[0]).toEqual({ id: 3, date: '2026-01-02', description: 'NETFLIX', amount: { value: -9.99, currency: 'USD' }, category: { id: 2, name: 'Streaming', group: 'Fun' } });
  });

  it('create_transaction checks ownership then posts the app body', async () => {
    const { result, calls } = await run('create_transaction', {
      date: '2026-02-01', accountId: 1, categoryId: 5, description: 'Salary', amount: 2500, currency: 'EUR', tags: ['Work'],
    }, {
      'GET /api/accounts': { id: 1 }, 'GET /api/categories': { id: 5 },
      'POST /api/transactions': ({ body }: any) => ({ id: 11, transaction_date: body.transaction_date, credit: body.credit, debit: body.debit, currency: 'EUR', categoryId: 5 }),
    });
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      transaction_date: '2026-02-01', accountId: 1, categoryId: 5, description: 'Salary', currency: 'EUR', credit: 2500, debit: null, tags: ['Work'],
    });
    expect(result.created).toEqual([{ id: 11, date: '2026-02-01', amount: { value: 2500, currency: 'EUR' }, categoryId: 5 }]);
  });

  it('create_transaction reports a foreign account as not found without posting', async () => {
    const { api, calls } = fakeApi({ 'GET /api/accounts': notFound(), 'GET /api/categories': { id: 5 } });
    const tool = getTool('create_transaction')!;
    await expect(tool.handler({ date: '2026-02-01', accountId: 99, categoryId: 5, description: 'x', amount: -1, currency: 'EUR' }, { api }))
      .rejects.toMatchObject({ name: 'ToolNotFoundError' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('update_transaction merges onto the current record (PUT replaces everything)', async () => {
    const existing = { ...restTx, details: 'note', ticker: 'X', assetQuantity: '2', assetPrice: '3', isin: 'I', exchange: 'E', assetCurrency: 'EUR' };
    const { calls } = await run('update_transaction', { transactionId: 9, categoryId: 6 }, {
      'GET /api/transactions': existing, 'GET /api/categories': { id: 6 },
      'PUT /api/transactions': ({ body }: any) => ({ ...restTx, categoryId: body.categoryId }),
    });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.query).toEqual({ id: 9 });
    expect(put.body).toEqual({
      transaction_date: '2026-02-10', accountId: 1, categoryId: 6, description: 'Shop', details: 'note', currency: 'EUR',
      credit: null, debit: 30, ticker: 'X', assetQuantity: 2, assetPrice: 3, isin: 'I', exchange: 'E', assetCurrency: 'EUR',
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/transactions', 'GET /api/categories', 'PUT /api/transactions']);
  });

  it('update_transaction amount and tags', async () => {
    const { calls } = await run('update_transaction', { transactionId: 9, amount: 12, tags: ['A'] }, {
      'GET /api/transactions': restTx, 'PUT /api/transactions': restTx,
    });
    expect(calls[1].body).toMatchObject({ credit: 12, debit: null, tags: ['A'] });
  });

  it('delete_transaction', async () => {
    const { result, calls } = await run('delete_transaction', { transactionId: 9 }, { 'DELETE /api/transactions': null });
    expect(calls[0].query).toEqual({ id: 9 });
    expect(result).toEqual({ deleted: 9 });
  });
});

describe('analytics tools', () => {
  it('periodQuery validates formats per view', () => {
    expect(periodQuery('month', '2026-01', '2026-03')).toEqual({ startMonth: '2026-01', endMonth: '2026-03' });
    expect(periodQuery('quarter', '2025-Q4', '2026-Q1')).toEqual({ startQuarter: '2025-Q4', endQuarter: '2026-Q1' });
    expect(periodQuery('year', '2024', '2026')).toEqual({ years: [2024, 2025, 2026] });
    expect(() => periodQuery('month', '2026-1', '2026-03')).toThrow(/2026-03/);
    expect(() => periodQuery('year', '2026', '2024')).toThrow(/after/);
  });

  it('get_spending_summary uses the display currency and flattens rows', async () => {
    const { result, calls } = await run('get_spending_summary', { view: 'month', from: '2026-01', to: '2026-02', groups: ['Food'] }, {
      'GET /api/tenants/settings': { portfolioCurrency: 'EUR' },
      'GET /api/analytics': {
        data: {
          '2026-02': { Essentials: { Food: { credit: 0, debit: 250.456, balance: -250.456 } } },
          '2026-01': { Essentials: { Food: { credit: 10, debit: 200, balance: -190 }, Home: { credit: 0, debit: 50, balance: -50 } } },
        },
      },
    });
    expect(calls[1].query).toMatchObject({ view: 'month', currency: 'EUR', startMonth: '2026-01', endMonth: '2026-02', groups: ['Food'] });
    expect(result.rows[0]).toEqual({ period: '2026-01', type: 'Essentials', group: 'Food', in: 10, out: 200, net: -190 });
    expect(result.totalsByType).toEqual([
      { period: '2026-01', type: 'Essentials', in: 10, out: 250, net: -240 },
      { period: '2026-02', type: 'Essentials', in: 0, out: 250.46, net: -250.46 },
    ]);
  });

  it('get_tag_summary', async () => {
    const { result, calls } = await run('get_tag_summary', { tagIds: [4], view: 'year', from: '2026', to: '2026', currency: 'USD' }, {
      'GET /api/analytics/tags': { tags: { 4: { 2026: { Lifestyle: { Travel: { Hotels: { credit: 0, debit: 800, balance: -800 } } } } } } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toMatchObject({ tagIds: [4], years: [2026], currency: 'USD' });
    expect(result.tags[0]).toMatchObject({ tagId: 4, totalOut: 800, rows: [{ category: 'Hotels', out: 800 }] });
  });

  it('list_insights / generate_insights / dismiss_insight / get_notifications_summary', async () => {
    const list = await run('list_insights', { tier: 'MONTHLY', limit: 1 }, {
      'GET /api/insights': { insights: [{ id: 'i1', tier: 'MONTHLY', title: 'T', body: 'B', metadata: { suggestedAction: 'Do x' }, date: '2026-03-02' }], total: 3, tierSummary: {} },
    });
    expect(list.calls[0].query).toMatchObject({ tier: 'MONTHLY', limit: 1, offset: 0, includeDismissed: undefined });
    expect(list.result).toMatchObject({ items: [{ id: 'i1', suggestedAction: 'Do x', date: '2026-03-02' }], hasMore: true });

    const gen = await run('generate_insights', { tier: 'QUARTERLY', year: 2026, quarter: 1 }, { 'POST /api/insights': { tier: 'QUARTERLY' } });
    expect(gen.calls[0].body).toEqual({ tier: 'QUARTERLY', year: 2026, month: undefined, quarter: 1, force: false });

    const dis = await run('dismiss_insight', { insightId: 'i1' }, { 'PUT /api/insights': { id: 'i1', dismissed: true } });
    expect(dis.calls[0].body).toEqual({ insightId: 'i1', dismissed: true });

    const notif = await run('get_notifications_summary', {}, { 'GET /api/notifications/summary': { totalUnseen: 2, signals: [{ type: 'PENDING_REVIEW', count: 2, isNew: true, href: '/x' }] } });
    expect(notif.result).toEqual({ totalUnseen: 2, signals: [{ type: 'PENDING_REVIEW', count: 2, isNew: true }] });
  });
});

describe('plaid review tools', () => {
  it('get_plaid_review_queue flips Plaid amounts and never returns raw payloads', async () => {
    const { result, calls } = await run('get_plaid_review_queue', { minConfidence: 0.9 }, {
      'GET /api/plaid/transactions': {
        transactions: [{ id: 'p1', amount: 12.5, date: '2026-03-01', name: 'SHOP', merchantName: 'Shop', isoCurrencyCode: 'USD', suggestedCategoryId: 5, suggestedCategory: { name: 'G', group: 'F', type: 'E' }, aiConfidence: 0.95, promotionStatus: 'CLASSIFIED', plaidItemId: 'it1', rawJson: 'secret' }],
        pagination: { total: 1 }, summary: { classified: 1 },
      },
    });
    expect(calls[0].query).toMatchObject({ minConfidence: 0.9, page: 1, limit: 50 });
    expect(result.items[0]).toMatchObject({ id: 'p1', description: 'Shop', amount: { value: -12.5, currency: 'USD' }, confidence: 0.95, plaidItemId: 'it1' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('review_plaid_transactions maps each action and reports per-item failures', async () => {
    const { result, calls } = await run('review_plaid_transactions', {
      items: [
        { id: 'a', action: 'approve' }, { id: 'b', action: 'approve', categoryId: 3 }, { id: 'c', action: 'recategorize', categoryId: 4 },
        { id: 'd', action: 'skip' }, { id: 'e', action: 'unskip' }, { id: 'f', action: 'skip' },
      ],
    }, {
      'PUT /api/plaid/transactions/a': { promotionStatus: 'PROMOTED' },
      'PUT /api/plaid/transactions/b': { promotionStatus: 'PROMOTED' },
      'PUT /api/plaid/transactions/c': { promotionStatus: 'CLASSIFIED' },
      'PUT /api/plaid/transactions/d': { promotionStatus: 'SKIPPED' },
      'PUT /api/plaid/transactions/e': { promotionStatus: 'CLASSIFIED' },
    });
    expect(calls.map((c) => c.body)).toEqual([
      { promotionStatus: 'PROMOTED' }, { promotionStatus: 'PROMOTED', suggestedCategoryId: 3 }, { suggestedCategoryId: 4 },
      { promotionStatus: 'SKIPPED' }, { promotionStatus: 'CLASSIFIED' }, { promotionStatus: 'SKIPPED' },
    ]);
    expect(result).toMatchObject({ succeeded: 5, failed: 1 });
    expect(result.results[5]).toMatchObject({ id: 'f', ok: false, error: expect.stringMatching(/Not found/) });
  });

  it('review_plaid_transactions bulkPromote and argument checks', async () => {
    const r = await run('review_plaid_transactions', { bulkPromote: { minConfidence: 0.9 } }, { 'POST /api/plaid/transactions/bulk-promote': { promoted: 4, skipped: 0, errors: 0 } });
    expect(r.calls[0].body).toEqual({ minConfidence: 0.9 });
    const ids = await run('review_plaid_transactions', { bulkPromote: { ids: ['a'], overrideCategoryId: 2 } }, { 'POST /api/plaid/transactions/bulk-promote': { promoted: 1 } });
    expect(ids.calls[0].body).toEqual({ transactionIds: ['a'], overrideCategoryId: 2 });
    await expect(run('review_plaid_transactions', {}, {})).rejects.toThrow(/either/);
    await expect(run('review_plaid_transactions', { bulkPromote: {} }, {})).rejects.toThrow(/minConfidence or ids/);
    await expect(run('review_plaid_transactions', { items: [{ id: 'a', action: 'recategorize' }] }, {})).rejects.toThrow(/categoryId/);
  });

  it('requeue, seeds and confirm seeds', async () => {
    const rq = await run('requeue_plaid_transactions', { failedIds: ['x'], allSkipped: true, plaidItemId: 'it' }, {
      'POST /api/plaid/transactions/x/retry': {}, 'POST /api/plaid/transactions/bulk-requeue': { updated: 3 },
    });
    expect(rq.result).toEqual({ retried: [{ id: 'x', ok: true }], requeued: 3 });
    await expect(run('requeue_plaid_transactions', {}, {})).rejects.toThrow(/failedIds/);

    const seeds = await run('list_plaid_seeds', { plaidItemId: 'it' }, { 'GET /api/plaid/transactions/seeds': [{ description: 'Shop', rawName: 'SHOP', count: 3, suggestedCategoryId: 5, suggestedCategory: { name: 'G', group: 'F' }, aiConfidence: 0.8 }] });
    expect(seeds.result.items[0]).toMatchObject({ description: 'Shop', count: 3, suggestedCategory: { id: 5 } });

    const conf = await run('confirm_plaid_seeds', { plaidItemId: 'it', seeds: [{ description: 'Shop', categoryId: 5 }] }, { 'POST /api/plaid/transactions/confirm-seeds': { confirmed: 1, promoted: 3 } });
    expect(conf.calls[0].body).toEqual({ plaidItemId: 'it', seeds: [{ description: 'Shop', rawName: undefined, confirmedCategoryId: 5 }] });
  });
});

describe('import tools', () => {
  it('list_imports without and with importId', async () => {
    const pending = await run('list_imports', {}, { 'GET /api/imports/pending': { imports: [{ id: 'imp', fileName: 'a.csv', pendingRowCount: 2 }] } });
    expect(pending.result).toMatchObject({ items: [{ importId: 'imp', rowsToReview: 2 }], total: 1, hasMore: false, nextCursor: null });

    const detail = await run('list_imports', { importId: 'imp', status: ['PENDING', 'ERROR'] }, {
      'GET /api/imports/imp': {
        import: { id: 'imp', status: 'READY', statusSummary: { PENDING: 1 } },
        rows: [{ id: 'r1', rowNumber: 1, transactionDate: '2026-04-01', description: 'X', debit: '5', credit: null, currency: 'EUR', status: 'PENDING', rawData: { secret: 1 } }],
        categorySummary: [{ categoryId: null, category: null, count: 1, eligibleCount: 0 }],
        pagination: { total: 1 },
      },
    });
    expect(detail.calls[0].query).toMatchObject({ status: 'PENDING,ERROR', page: 1, limit: 50 });
    expect(detail.result.rows[0]).toMatchObject({ rowId: 'r1', amount: { value: -5, currency: 'EUR' } });
    expect(JSON.stringify(detail.result)).not.toContain('secret');
  });

  it('review_import_rows per row and bulk', async () => {
    const r = await run('review_import_rows', { importId: 'imp', rows: [{ rowId: 'r1', categoryId: 5, status: 'CONFIRMED' }, { rowId: 'r2' }] }, {
      'PUT /api/imports/imp/rows/r1': { row: { status: 'CONFIRMED' } },
    });
    expect(r.calls[0].body).toEqual({ status: 'CONFIRMED', suggestedCategoryId: 5 });
    expect(r.result).toMatchObject({ succeeded: 1, failed: 1, results: [{ ok: true }, { ok: false, error: 'Nothing to change.' }] });

    const bulk = await run('review_import_rows', { importId: 'imp', bulkConfirm: { uncategorized: true } }, { 'POST /api/imports/imp/bulk-confirm': { confirmed: 7 } });
    expect(bulk.calls[0].body).toEqual({ uncategorized: true });
    await expect(run('review_import_rows', { importId: 'imp' }, {})).rejects.toThrow(/either/);
  });

  it('seeds and finalize', async () => {
    const seeds = await run('list_import_seeds', { importId: 'imp' }, { 'GET /api/imports/imp/seeds': [{ description: 'X', count: 4, suggestedCategoryId: null }] });
    expect(seeds.result.items[0]).toEqual({ description: 'X', count: 4, suggestedCategory: null });
    const conf = await run('confirm_import_seeds', { importId: 'imp', seeds: [{ description: 'X', categoryId: 5 }] }, { 'POST /api/imports/imp/confirm-seeds': { confirmed: 4 } });
    expect(conf.calls[0].body).toEqual({ seeds: [{ description: 'X', confirmedCategoryId: 5 }] });
    expect(conf.result).toEqual({ rowsConfirmed: 4 });
    const commit = await run('finalize_import', { importId: 'imp', action: 'commit', rowIds: ['r1'] }, { 'POST /api/imports/imp': { status: 'COMMITTING' } });
    expect(commit.calls[0].body).toEqual({ action: 'commit', rowIds: ['r1'] });
    const cancel = await run('finalize_import', { importId: 'imp', action: 'cancel', rowIds: ['r1'] }, { 'POST /api/imports/imp': { cancelled: true } });
    expect(cancel.calls[0].body).toEqual({ action: 'cancel' });
    expect(cancel.result.status).toBe('CANCELLED');
  });
});

describe('portfolio tools', () => {
  it('get_portfolio_holdings positions (default) with display currency', async () => {
    const { result } = await run('get_portfolio_holdings', { limit: 1 }, {
      'GET /api/portfolio/items': {
        portfolioCurrency: 'EUR',
        items: [
          { id: 1, symbol: 'VWCE', currency: 'EUR', quantity: '10', category: { name: 'ETF', group: 'Stocks', type: 'Investments' }, native: { marketValue: '1000', costBasis: '800', unrealizedPnL: '200', unrealizedPnLPercent: '25', realizedPnL: '0' }, usd: { marketValue: '1090' }, portfolio: { marketValue: '1000' }, incomeTerms: null, debtTerms: null },
          { id: 2, symbol: 'X' },
        ],
      },
    });
    expect(result).toMatchObject({ view: 'positions', displayCurrency: 'EUR', total: 2, hasMore: true });
    expect(result.items[0]).toMatchObject({ assetId: 1, marketValue: { value: 1000, currency: 'EUR' }, marketValueDisplay: { value: 1000, currency: 'EUR' }, unrealizedPnLPercent: 25 });
  });

  it('get_portfolio_holdings attention and snapshots views', async () => {
    const att = await run('get_portfolio_holdings', { view: 'attention', status: 'stale' }, {
      'GET /api/portfolio/assets': { portfolioCurrency: 'USD', items: [{ id: 3, symbol: 'Flat', currentValueInDisplay: 5, needsAttention: true }], totals: { count: 1, attention: 1 }, nextCursor: null },
    });
    expect(att.calls[0].query).toMatchObject({ status: 'stale', limit: 50 });
    expect(att.result).toMatchObject({ total: 1, needingAttention: 1, hasMore: false, items: [{ assetId: 3, valueDisplay: { value: 5, currency: 'USD' } }] });
    const snap = await run('get_portfolio_holdings', { view: 'snapshots', ticker: 'VWCE' }, {
      'GET /api/portfolio/holdings': { pagination: { totalCount: 1 }, data: [{ portfolioItemId: 1, date: '2026-01-01', quantity: '1', totalValue: '100', costBasis: '90', asset: { symbol: 'VWCE', currency: 'EUR' } }] },
    });
    expect(snap.calls[0].query).toMatchObject({ ticker: 'VWCE', page: 1, pageSize: 50 });
    expect(snap.result.items[0]).toEqual({ assetId: 1, symbol: 'VWCE', date: '2026-01-01', quantity: 1, value: { value: 100, currency: 'EUR' }, costBasis: { value: 90, currency: 'EUR' } });
  });

  it('get_portfolio_history and get_equity_analysis', async () => {
    const hist = await run('get_portfolio_history', { resolution: 'monthly', types: ['Investments'] }, {
      'GET /api/portfolio/history': { portfolioCurrency: 'EUR', resolution: 'monthly', history: [{ date: '2026-01-31', totalUSD: 110, totalPortfolioCurrency: 100.004, Investments: { total: 100, groups: {} } }] },
    });
    expect(hist.calls[0].query).toMatchObject({ resolution: 'monthly', type: 'Investments' });
    expect(hist.result).toMatchObject({ currency: 'EUR', items: [{ date: '2026-01-31', total: 100, byType: { Investments: 100 } }] });

    const eq = await run('get_equity_analysis', { groupBy: 'country', lookThrough: false, topHoldings: 1 }, {
      'GET /api/portfolio/equity-analysis': {
        portfolioCurrency: 'USD', lookThrough: false, summary: { holdingsCount: 2 },
        groups: [{ name: 'US', totalValue: 70, weight: 0.7, holdingsCount: 1 }],
        holdings: [{ symbol: 'AAPL', currentValue: 70, weight: 0.7, dividendYield: 0.005 }, { symbol: 'X', currentValue: 30 }],
      },
    });
    expect(eq.calls[0].query).toEqual({ groupBy: 'country', accountId: undefined, lookThrough: 'false' });
    expect(eq.result.groups[0]).toEqual({ name: 'US', value: { value: 70, currency: 'USD' }, weightPct: 70, holdings: 1 });
    expect(eq.result.topHoldings).toHaveLength(1);
    expect(eq.result.topHoldings[0]).toMatchObject({ weight: 70, dividendYieldPct: 0.5 });
  });

  it('get_passive_income bundles projection, streams and detached terms', async () => {
    const { result, calls } = await run('get_passive_income', { horizon: 24 }, {
      'GET /api/portfolio/passive-income': { displayCurrency: 'EUR', horizon: 24, kpis: { next12mIncome: 1 }, groups: [], items: [{ big: true }] },
      'GET /api/portfolio/income-terms/detached': { detached: [{ id: 4, orphanedLabel: 'Old', incomeType: 'RENT' }] },
      'GET /api/passive-income/streams': { streams: [{ id: 2, name: 'Pension', amountPerPayment: 500, currency: 'EUR', frequency: 'MONTHLY', startDate: '2026-01-01' }], eligibleCategories: [{ id: 9 }] },
    });
    expect(calls[0].query).toEqual({ horizon: 24 });
    expect(result).toMatchObject({ currency: 'EUR', kpis: { next12mIncome: { value: 1, currency: 'EUR' } }, detachedTerms: [{ termsId: 4 }], streams: [{ streamId: 2, amountPerPayment: { value: 500, currency: 'EUR' } }] });
    expect(result.items).toBeUndefined();
  });

  it('get_passive_income labels holding values with the display currency, not the holding currency (B6)', async () => {
    const { result } = await run('get_passive_income', {}, {
      'GET /api/portfolio/passive-income': {
        displayCurrency: 'USD',
        kpis: { next12mIncome: 24, yieldOnValue: 0.0123 },
        groups: [{ label: 'VWCE', symbol: 'VWCE', assetClass: 'INDEX_ETF', portfolioItemIds: [1], accountCount: 1, currency: 'EUR', currentValue: 192.51, next12mTotal: 3.2, horizonTotal: 3.2, amountPerPayment: 0.8, rateOrYield: 0.0166, status: 'OK', children: [{ big: true }] }],
        upcomingPaymentsGrouped: [{ date: '2026-10-15', label: 'VWCE', amount: 0.8 }],
      },
      'GET /api/portfolio/income-terms/detached': { detached: [] },
      'GET /api/passive-income/streams': { streams: [] },
    });
    expect(result.kpis).toMatchObject({ next12mIncome: { value: 24, currency: 'USD' }, yieldOnValuePct: 1.23 });
    expect(result.byHolding[0]).toMatchObject({
      holdingCurrency: 'EUR',
      currentValue: { value: 192.51, currency: 'USD' },
      next12mIncome: { value: 3.2, currency: 'USD' },
      rateOrYieldPct: 1.66,
      assetIds: [1],
    });
    expect(result.byHolding[0].children).toBeUndefined();
    expect(result.upcomingPayments[0].amount).toEqual({ value: 0.8, currency: 'USD' });
  });

  it('get_holding_details: asset class is primary, other parts fail soft', async () => {
    const { result } = await run('get_holding_details', { assetId: 7 }, {
      'GET /api/portfolio/items/7/asset-class': { assetClass: 'REAL_ESTATE', assetClassSource: 'AUTO', autoAssetClass: 'REAL_ESTATE' },
      'GET /api/portfolio/items/7/income-terms': notFound(),
      'GET /api/portfolio/items/7/debt-terms': notFound(),
      'GET /api/portfolio/items/7/manual-values': [{ id: 'v1', date: '2026-05-01', value: '250000', currency: 'EUR' }],
    });
    expect(result).toMatchObject({ assetClass: 'REAL_ESTATE', incomeTerms: null, debtTerms: null, manualValues: [{ valueId: 'v1', value: { value: 250000, currency: 'EUR' } }] });
    await expect(run('get_holding_details', { assetId: 8 }, {})).rejects.toMatchObject({ status: 404 });
  });

  it('set_asset_class and manage_manual_values', async () => {
    const ac = await run('set_asset_class', { assetId: 7, assetClass: null }, { 'PUT /api/portfolio/items/7/asset-class': { assetClass: 'STOCK', updatedCount: 1 } });
    expect(ac.calls[0].body).toEqual({ assetClass: null, applyToSymbol: false });
    const routes = {
      'POST /api/portfolio/items/7/manual-values': ({ body }: any) => ({ id: 'v1', ...body }),
      'PUT /api/portfolio/items/7/manual-values/v1': ({ body }: any) => ({ id: 'v1', date: '2026-01-01', value: body.value, currency: body.currency ?? 'EUR' }),
      'DELETE /api/portfolio/items/7/manual-values/v1': null,
    };
    expect((await run('manage_manual_values', { assetId: 7, action: 'add', date: '2026-01-01', value: 10, currency: 'EUR' }, routes)).result).toEqual({ added: { valueId: 'v1', date: '2026-01-01', value: { value: 10, currency: 'EUR' } } });
    expect((await run('manage_manual_values', { assetId: 7, action: 'update', valueId: 'v1', value: 11 }, routes)).result.updated.value).toEqual({ value: 11, currency: 'EUR' });
    expect((await run('manage_manual_values', { assetId: 7, action: 'delete', valueId: 'v1' }, routes)).result).toEqual({ deleted: 'v1' });
    await expect(run('manage_manual_values', { assetId: 7, action: 'add', date: '2026-01-01' }, routes)).rejects.toThrow(/add requires/);
    await expect(run('manage_manual_values', { assetId: 7, action: 'delete' }, routes)).rejects.toThrow(/valueId/);
  });

  it('manage_income_and_debt_terms routes each action', async () => {
    const routes = {
      'PUT /api/portfolio/items/7/income-terms': { terms: { id: 1 }, appliedTo: [7, 8] },
      'DELETE /api/portfolio/items/7/income-terms': { deleted: 2 },
      'POST /api/portfolio/income-terms/4/attach': { terms: { id: 4 } },
      'DELETE /api/portfolio/income-terms/4': null,
      'PUT /api/portfolio/items/7/debt-terms': notFound(),
      'POST /api/portfolio/items/7/debt-terms': { id: 3 },
    };
    const set = await run('manage_income_and_debt_terms', { target: 'income', action: 'set', assetId: 7, applyToSymbol: true, terms: { incomeType: 'DIVIDEND', yieldPct: 3 } }, routes);
    expect(set.calls[0].body).toEqual({ incomeType: 'DIVIDEND', yieldPct: 3, applyToSymbol: true });
    expect(set.result.appliedTo).toEqual([7, 8]);
    const del = await run('manage_income_and_debt_terms', { target: 'income', action: 'delete', assetId: 7, applyToSymbol: true }, routes);
    expect(del.calls[0].query).toEqual({ applyToSymbol: 'true' });
    expect((await run('manage_income_and_debt_terms', { target: 'income', action: 'attach', termsId: 4, assetId: 7 }, routes)).calls[0].body).toEqual({ assetId: 7 });
    expect((await run('manage_income_and_debt_terms', { target: 'income', action: 'deleteDetached', termsId: 4 }, routes)).result).toEqual({ deleted: 4 });
    const debt = await run('manage_income_and_debt_terms', { target: 'debt', action: 'set', assetId: 7, initialBalance: 1000, interestRate: 4, termInMonths: 120, originationDate: '2020-01-01' }, routes);
    expect(debt.calls.map((c) => c.method)).toEqual(['PUT', 'POST']);
    expect(debt.result).toEqual({ debtTerms: { id: 3, created: true } });
    await expect(run('manage_income_and_debt_terms', { target: 'debt', action: 'set', assetId: 7 }, routes)).rejects.toThrow(/requires initialBalance/);
    await expect(run('manage_income_and_debt_terms', { target: 'debt', action: 'delete', assetId: 7 }, routes)).rejects.toThrow(/only supports/);
    await expect(run('manage_income_and_debt_terms', { target: 'income', action: 'set', assetId: 7 }, routes)).rejects.toThrow(/terms/);
    await expect(run('manage_income_and_debt_terms', { target: 'income', action: 'set' }, routes)).rejects.toThrow(/assetId/);
    await expect(run('manage_income_and_debt_terms', { target: 'income', action: 'attach', termsId: 4 }, routes)).rejects.toThrow(/assetId/);
  });

  it('manage_passive_income_streams merges updates onto the current stream', async () => {
    const current = { id: 2, categoryId: 9, name: 'Pension', amountPerPayment: 500, frequency: 'MONTHLY', currency: 'EUR', startDate: '2026-01-01T00:00:00.000Z', endDate: null };
    const routes = {
      'GET /api/passive-income/streams': { streams: [current] },
      'PUT /api/passive-income/streams/2': ({ body }: any) => ({ id: 2, ...body }),
      'POST /api/passive-income/streams': ({ body }: any) => ({ id: 3, ...body }),
      'DELETE /api/passive-income/streams/2': null,
    };
    const upd = await run('manage_passive_income_streams', { action: 'update', streamId: 2, amountPerPayment: 550 }, routes);
    expect(upd.calls[1].body).toMatchObject({ categoryId: 9, name: 'Pension', amountPerPayment: 550, frequency: 'MONTHLY', currency: 'EUR', incomeType: 'FIXED_AMOUNT' });
    const created = await run('manage_passive_income_streams', { action: 'create', categoryId: 9, name: 'Allowance', amountPerPayment: 100, frequency: 'MONTHLY', currency: 'EUR', startDate: '2026-01-01' }, routes);
    expect(created.calls[0].body).toMatchObject({ incomeType: 'FIXED_AMOUNT', name: 'Allowance' });
    expect((await run('manage_passive_income_streams', { action: 'delete', streamId: 2 }, routes)).result).toEqual({ deleted: 2 });
    await expect(run('manage_passive_income_streams', { action: 'update', streamId: 5, name: 'x' }, routes)).rejects.toMatchObject({ name: 'ToolNotFoundError' });
    await expect(run('manage_passive_income_streams', { action: 'delete' }, routes)).rejects.toThrow(/streamId/);
  });
});

describe('subscription tools', () => {
  it('list_subscriptions renames the merchant hash to subscriptionId', async () => {
    const { result, calls } = await run('list_subscriptions', { view: 'all' }, {
      'GET /api/subscriptions': {
        displayCurrency: 'EUR', summary: { monthlyTotal: 20 }, total: 1,
        items: [{ descriptionHash: 'h1', merchantLabel: 'Netflix', amount: 9.99, currency: 'EUR', amountInDisplayCurrency: 9.99, monthlyAmount: 9.99, mergedIntoHash: 'h2', mergedIntoLabel: 'NF', contributingTransactionIds: [1, 2] }],
      },
    });
    expect(calls[0].query).toMatchObject({ view: 'all', page: 1, limit: 25 });
    expect(result.items[0]).toMatchObject({ subscriptionId: 'h1', merchant: 'Netflix', mergedInto: { subscriptionId: 'h2', merchant: 'NF' }, transactionIds: [1, 2] });
  });

  it('update_subscription maps every action to the REST body', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ action: 'confirm', subscriptionId: 'h' }, { action: 'confirm', descriptionHash: 'h' }],
      [{ action: 'confirm', transactionId: 5 }, { action: 'confirm', transactionId: 5 }],
      [{ action: 'dismiss', subscriptionId: 'h' }, { action: 'dismiss', descriptionHash: 'h' }],
      [{ action: 'restore', subscriptionId: 'h' }, { action: 'restore', descriptionHash: 'h' }],
      [{ action: 'unmerge', subscriptionId: 'h' }, { action: 'unmerge', descriptionHash: 'h' }],
      [{ action: 'setCadence', subscriptionId: 'h', cadence: 'ANNUAL' }, { action: 'setCadence', descriptionHash: 'h', cadence: 'ANNUAL' }],
      [{ action: 'rename', subscriptionId: 'h', merchantLabel: 'NF' }, { action: 'rename', descriptionHash: 'h', merchantLabel: 'NF' }],
      [{ action: 'merge', subscriptionId: 'a', targetSubscriptionId: 'b' }, { action: 'merge', sourceDescriptionHash: 'a', targetDescriptionHash: 'b' }],
      [{ action: 'refresh' }, { action: 'refresh' }],
    ];
    for (const [args, body] of cases) {
      const { calls } = await run('update_subscription', args, { 'POST /api/subscriptions': { ok: true } });
      expect(calls[0].body).toEqual(body);
    }
    const renamed = await run('update_subscription', { action: 'rename', subscriptionId: 'h', merchantLabel: 'NF' }, {
      'POST /api/subscriptions': { descriptionHash: 'h', merchantLabel: 'NF', state: 'CONFIRMED', cadence: 'MONTHLY' },
    });
    expect(renamed.result).toEqual({ action: 'rename', subscriptionId: 'h', merchant: 'NF', state: 'CONFIRMED', cadence: 'MONTHLY' });
    await expect(run('update_subscription', { action: 'confirm' }, {})).rejects.toThrow(/subscriptionId or transactionId/);
    await expect(run('update_subscription', { action: 'setCadence', subscriptionId: 'h' }, {})).rejects.toThrow(/cadence/);
  });
});
