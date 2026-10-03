import { z } from 'zod';
import { defineTool, cursorField, limitField, dateString, intId } from '../define.js';
import { ToolInputError, ToolNotFoundError } from '../errors.js';
import { LoopbackError } from '../loopback.js';
import { pageArgs, pageMeta, offsetArgs, offsetMeta, paginate, num, isoDate } from '../shape.js';

/** Reference data (#89): accounts, categories, tags, banks, countries, currencies, FX, tickers. */

const ACCOUNT_HINT = 'Use list_accounts to find account IDs.';
const CATEGORY_HINT = 'Use list_categories to find category IDs.';
const TAG_HINT = 'Use list_tags to find tag IDs.';

/** Shared by list_accounts and create_account (#98). */
export function shapeAccount(a) {
  const number = typeof a.accountNumber === 'string' ? a.accountNumber : '';
  return {
    id: a.id,
    name: a.name,
    bankId: a.bankId ?? a.bank?.id ?? null,
    bank: a.bank?.name ?? null,
    currency: a.currencyCode,
    country: a.country?.name ?? a.countryId ?? null,
    accountNumberLast4: number ? number.slice(-4) : (a.accountNumberLast4 ?? null),
    linkedToPlaid: a.plaidAccountId != null,
  };
}

function shapeCategory(c) {
  return {
    id: c.id,
    name: c.name,
    group: c.group,
    type: c.type,
    icon: c.icon ?? null,
    isRecurring: c.isRecurring ?? false,
    processingHint: c.processingHint ?? null,
    transactionCount: c._count?.transactions ?? null,
  };
}

function shapeTag(t) {
  return {
    id: t.id,
    name: t.name,
    color: t.color ?? null,
    emoji: t.emoji ?? null,
    budget: num(t.budget),
    startDate: isoDate(t.startDate),
    endDate: isoDate(t.endDate),
  };
}

/**
 * Tenant ownership pre-checks. `POST`/`PUT /api/transactions` accept any
 * accountId/categoryId, so tools that take one verify it through the
 * tenant-scoped GET first and report a foreign ID as not found.
 */
export async function ensureAccount(api, id) {
  try {
    return await api.get('/api/accounts', { id });
  } catch (err) {
    if (err instanceof LoopbackError && (err.status === 404 || err.status === 403)) {
      throw new ToolNotFoundError(`account ${id}`, ACCOUNT_HINT);
    }
    throw err;
  }
}

export async function ensureCategory(api, id) {
  try {
    return await api.get('/api/categories', { id });
  } catch (err) {
    if (err instanceof LoopbackError && (err.status === 404 || err.status === 403 || err.status === 400)) {
      throw new ToolNotFoundError(`category ${id}`, CATEGORY_HINT);
    }
    throw err;
  }
}

const listAccounts = defineTool({
  name: 'list_accounts',
  access: 'read',
  title: 'List accounts',
  description:
    'List the user\'s bank, card and brokerage accounts with their IDs, bank, currency and country. '
    + 'Use the returned `id` as accountId in other tools.',
  input: {
    currencyCode: z.string().length(3).optional().describe('Only accounts in this currency (ISO code).'),
    countryId: z.string().max(3).optional().describe('Only accounts in this country (ISO country code).'),
    limit: limitField(100),
    cursor: cursorField,
  },
  wraps: [{ method: 'GET', route: '/api/accounts' }],
  async handler(args, { api }) {
    const p = pageArgs(args, 100);
    const data = await api.get('/api/accounts', {
      currencyCode: args.currencyCode,
      countryId: args.countryId,
      page: p.page,
      limit: p.limit,
    });
    return { items: (data.accounts || []).map(shapeAccount), total: data.total, ...pageMeta(p, data.total) };
  },
});

const listCategories = defineTool({
  name: 'list_categories',
  access: 'read',
  title: 'List categories',
  description:
    'List transaction categories with their IDs, group and type (e.g. type "Essentials", group "Food"). '
    + 'Categories are what transactions, review items and import rows are classified into. '
    + 'Filter by name (partial, case-insensitive), group or type.',
  input: {
    name: z.string().max(100).optional().describe('Partial category name, case-insensitive.'),
    group: z.string().max(100).optional().describe('Exact category group, e.g. "Food".'),
    type: z.string().max(100).optional().describe('Exact category type, e.g. "Income", "Essentials", "Investments".'),
    limit: limitField(100),
    cursor: cursorField,
  },
  wraps: [{ method: 'GET', route: '/api/categories' }],
  async handler(args, { api }) {
    const p = pageArgs(args, 100);
    const data = await api.get('/api/categories', {
      name: args.name, group: args.group, type: args.type, page: p.page, limit: p.limit,
    });
    return { items: (data.categories || []).map(shapeCategory), total: data.total, ...pageMeta(p, data.total) };
  },
});

const KINDS = ['tenant', 'banks', 'countries', 'currencies', 'fxRates'];

function searchList(list, search, fields) {
  if (!search) return list;
  const q = search.toLowerCase();
  return list.filter((row) => fields.some((f) => String(row[f] ?? '').toLowerCase().includes(q)));
}

const getReferenceData = defineTool({
  name: 'get_reference_data',
  access: 'read',
  title: 'Get reference data',
  description:
    'Reference data for the user\'s workspace. `tenant`: display (portfolio) currency, enabled currencies and '
    + 'countries, years that have transactions, and classification thresholds — call it first to learn the '
    + 'currency to use for summaries. `banks`, `countries`, `currencies`: global lists (use `search` to filter). '
    + '`fxRates`: stored exchange rates for one date (requires fxDate).',
  input: {
    kinds: z.array(z.enum(KINDS)).min(1).max(KINDS.length).optional()
      .describe('Which lists to return (default ["tenant"]).'),
    search: z.string().max(100).optional().describe('Substring filter for banks, countries and currencies.'),
    fxDate: dateString('Date of the FX rates').optional(),
    fxFrom: z.string().length(3).optional().describe('FX rates from this currency only.'),
    fxTo: z.string().length(3).optional().describe('FX rates to this currency only.'),
  },
  wraps: [
    { method: 'GET', route: '/api/tenants' },
    { method: 'GET', route: '/api/tenants/settings' },
    { method: 'GET', route: '/api/banks' },
    { method: 'GET', route: '/api/countries' },
    { method: 'GET', route: '/api/currencies' },
    { method: 'GET', route: '/api/currency-rates' },
  ],
  async handler(args, { api }) {
    const kinds = new Set(args.kinds?.length ? args.kinds : ['tenant']);
    if (kinds.has('fxRates') && !args.fxDate) {
      throw new ToolInputError('fxRates requires fxDate (YYYY-MM-DD).');
    }
    const limited = (list) => paginate(list, { limit: 100 });
    const tasks = {};

    if (kinds.has('tenant')) {
      tasks.tenant = Promise.all([api.get('/api/tenants'), api.get('/api/tenants/settings')])
        .then(([tenants, settings]) => {
          const t = Array.isArray(tenants) ? tenants[0] : tenants;
          return {
            name: t?.name ?? null,
            displayCurrency: settings?.portfolioCurrency ?? t?.portfolioCurrency ?? 'USD',
            currencies: (t?.currencies || []).map((c) => ({ id: c.id, name: c.name, isDefault: c.isDefault ?? false })),
            countries: (t?.countries || []).map((c) => ({ id: c.id, name: c.name, isDefault: c.isDefault ?? false })),
            transactionYears: t?.transactionYears || [],
            autoPromoteThreshold: num(settings?.autoPromoteThreshold),
            reviewThreshold: num(settings?.reviewThreshold),
          };
        });
    }
    if (kinds.has('banks')) {
      tasks.banks = api.get('/api/banks')
        .then((rows) => limited(searchList((rows || []).map((b) => ({ id: b.id, name: b.name })), args.search, ['name'])));
    }
    if (kinds.has('countries')) {
      tasks.countries = api.get('/api/countries')
        .then((rows) => limited(searchList((rows || []).map((c) => ({ id: c.id, name: c.name, emoji: c.emoji ?? null })), args.search, ['id', 'name'])));
    }
    if (kinds.has('currencies')) {
      tasks.currencies = api.get('/api/currencies')
        .then((rows) => limited(searchList((rows || []).map((c) => ({ id: c.id, name: c.name, symbol: c.symbol ?? null })), args.search, ['id', 'name'])));
    }
    if (kinds.has('fxRates')) {
      const [year, month, day] = args.fxDate.split('-').map(Number);
      tasks.fxRates = api.get('/api/currency-rates', {
        year, month, day, currencyFrom: args.fxFrom, currencyTo: args.fxTo,
      }).then((rows) => limited((rows || []).map((r) => ({
        date: args.fxDate, from: r.currencyFrom, to: r.currencyTo, rate: num(r.value),
      }))));
    }

    const keys = Object.keys(tasks);
    const values = await Promise.all(keys.map((k) => tasks[k]));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  },
});

const searchTicker = defineTool({
  name: 'search_ticker',
  access: 'read',
  title: 'Search tickers',
  description: 'Look up stock, ETF or crypto tickers by symbol or company name (market data provider search).',
  input: {
    query: z.string().min(1).max(100).describe('Symbol or name, e.g. "VWCE" or "Apple".'),
    type: z.string().max(30).optional().describe('Optional instrument type filter passed to the provider.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
  },
  wraps: [{ method: 'GET', route: '/api/ticker/search' }],
  async handler(args, { api }) {
    const data = await api.get('/api/ticker/search', { q: args.query, type: args.type });
    const rows = Array.isArray(data) ? data : (data?.results || data?.data || []);
    return { items: rows.slice(0, args.limit ?? 20), total: rows.length };
  },
});

const listTags = defineTool({
  name: 'list_tags',
  access: 'read',
  title: 'List tags',
  description: 'List tags (free labels such as trips or projects, optionally with a budget and date range) with their IDs.',
  input: { limit: limitField(100), cursor: cursorField },
  wraps: [{ method: 'GET', route: '/api/tags' }],
  async handler(args, { api }) {
    const o = offsetArgs(args, 100);
    const data = await api.get('/api/tags', { limit: o.limit, offset: o.offset });
    return { items: (data.tags || []).map(shapeTag), total: data.total, ...offsetMeta(o, data.total) };
  },
});

const manageTags = defineTool({
  name: 'manage_tags',
  access: 'write',
  destructive: true,
  title: 'Create, update or delete a tag',
  description:
    'create: new tag (name required). update: change name, color, emoji, budget or dates of tagId. '
    + 'delete: remove tagId (refused while transactions still use it). Tag transactions with update_transaction.',
  input: {
    action: z.enum(['create', 'update', 'delete']),
    tagId: intId('Tag ID (update/delete). From list_tags.').optional(),
    name: z.string().min(1).max(100).optional(),
    color: z.string().max(20).optional().describe('Hex color, e.g. "#6D657A".'),
    emoji: z.string().max(10).optional(),
    budget: z.number().nonnegative().nullable().optional().describe('Budget amount; null clears it.'),
    startDate: dateString('Start date').nullable().optional(),
    endDate: dateString('End date').nullable().optional(),
  },
  wraps: [
    { method: 'POST', route: '/api/tags' },
    { method: 'PUT', route: '/api/tags' },
    { method: 'DELETE', route: '/api/tags' },
  ],
  notFoundHint: TAG_HINT,
  async handler(args, { api }) {
    const fields = Object.fromEntries(
      ['name', 'color', 'emoji', 'budget', 'startDate', 'endDate']
        .filter((k) => args[k] !== undefined)
        .map((k) => [k, args[k]]),
    );
    if (args.action === 'create') {
      if (!args.name) throw new ToolInputError('create requires name.');
      return { created: shapeTag(await api.post('/api/tags', fields)) };
    }
    if (!args.tagId) throw new ToolInputError(`${args.action} requires tagId.`);
    if (args.action === 'update') {
      if (Object.keys(fields).length === 0) throw new ToolInputError('update requires at least one field to change.');
      return { updated: shapeTag(await api.put('/api/tags', fields, { id: args.tagId })) };
    }
    await api.del('/api/tags', { id: args.tagId });
    return { deleted: args.tagId };
  },
});

export const HINTS = { ACCOUNT_HINT, CATEGORY_HINT, TAG_HINT };

const TOOLS = [listAccounts, listCategories, getReferenceData, searchTicker, listTags, manageTags];

export default TOOLS;
