import { z } from 'zod';
import { defineTool, cursorField, limitField, dateString, intId, currencyCode } from '../define.js';
import { ToolInputError } from '../errors.js';
import { pageArgs, pageMeta, num, isoDate, signedAmount } from '../shape.js';
import { ensureAccount, ensureCategory, HINTS } from './reference.js';

/** Transactions (#89): search, merchant history, create / update / delete. */

const TX_HINT = 'Use search_transactions to find transaction IDs.';

function shapeTransaction(t) {
  return {
    id: t.id,
    date: isoDate(t.transaction_date),
    description: t.description ?? null,
    details: t.details || null,
    amount: { value: signedAmount(t), currency: t.currency },
    account: t.account ? { id: t.accountId, name: t.account.name } : { id: t.accountId },
    category: t.category
      ? { id: t.categoryId, name: t.category.name, group: t.category.group, type: t.category.type }
      : { id: t.categoryId },
    tags: (t.tags || []).map((tag) => tag.name),
    source: t.source ?? null,
    // Ticker-less fund transactions still carry quantity + price.
    ...((t.ticker || t.assetQuantity != null) && {
      ticker: t.ticker ?? null, assetQuantity: num(t.assetQuantity), assetPrice: num(t.assetPrice),
    }),
  };
}

function restFilters(args) {
  return {
    startDate: args.from,
    endDate: args.to,
    accountId: args.accountId,
    categoryId: args.categoryId,
    group: args.categoryGroup,
    type: args.categoryType,
    tags: args.tag,
    currencyCode: args.currency,
    source: args.source,
    // Fixed 2 dp: the route takes plain decimals, and String(1e-7) is "1e-7".
    amountMin: args.amountMin?.toFixed(2),
    amountMax: args.amountMax?.toFixed(2),
  };
}

const amountBound = (what) => z.number().min(0).max(1e12).optional()
  .describe(`${what}, inclusive: an unsigned amount in the transaction's own currency, matched against money in or out at 2-decimal precision.`);

const searchTransactions = defineTool({
  name: 'search_transactions',
  access: 'read',
  title: 'Search transactions',
  description:
    'Search committed transactions, newest first. `totals` (in / out / net over the whole filtered set, not just '
    + 'this page) is only returned when `currency` is set. Amounts are signed: positive = money in (credit), '
    + 'negative = money out (debit), in the transaction\'s own currency. Filter by date range, account, category, '
    + 'category group/type, tag, currency, source or amount range. To find one transaction, combine a date range '
    + 'with amountMin = amountMax (e.g. 2003.76 for a €2,003.76 payment) and/or a category. Descriptions are '
    + 'encrypted at rest and cannot be searched: to find a merchant use get_merchant_history, or narrow by '
    + 'date/amount/category and read the page.',
  input: {
    from: dateString('Start date, inclusive').optional(),
    to: dateString('End date, inclusive').optional(),
    accountId: intId('Account ID from list_accounts.').optional(),
    categoryId: intId('Category ID from list_categories.').optional(),
    categoryGroup: z.string().max(100).optional().describe('Category group, e.g. "Food".'),
    categoryType: z.string().max(100).optional().describe('Category type, e.g. "Essentials" or "Income".'),
    tag: z.string().max(100).optional().describe('Tag name or tag ID.'),
    currency: currencyCode.optional().describe('Only transactions in this currency. Required for `totals`.'),
    source: z.enum(['MANUAL', 'PLAID', 'CSV']).optional(),
    amountMin: amountBound('Smallest amount'),
    amountMax: amountBound('Largest amount'),
    limit: limitField(50),
    cursor: cursorField,
  },
  wraps: [{ method: 'GET', route: '/api/transactions' }],
  async handler(args, { api }) {
    if (args.amountMin !== undefined && args.amountMax !== undefined && args.amountMin > args.amountMax) {
      throw new ToolInputError('amountMin cannot be greater than amountMax.');
    }
    const p = pageArgs(args, 50);
    const data = await api.get('/api/transactions', { ...restFilters(args), page: p.page, limit: p.limit });
    return {
      items: (data.transactions || []).map(shapeTransaction),
      total: data.total,
      ...pageMeta(p, data.total),
      ...(args.currency && {
        totals: {
          in: num(data.totals?.credit), out: num(data.totals?.debit), net: num(data.totals?.balance),
          currency: args.currency,
        },
      }),
    };
  },
});

const getMerchantHistory = defineTool({
  name: 'get_merchant_history',
  access: 'read',
  title: 'Get merchant history',
  description:
    'Past bank-synced (Plaid) transactions whose merchant or name contains `description`, with the category each '
    + 'was filed under — useful to decide how to categorise a new charge from the same merchant.',
  input: {
    description: z.string().min(2).max(200).describe('Merchant name or part of it.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
  },
  wraps: [{ method: 'GET', route: '/api/transactions/merchant-history' }],
  async handler(args, { api }) {
    const rows = await api.get('/api/transactions/merchant-history', {
      description: args.description, limit: args.limit ?? 10,
    });
    return {
      items: (rows || []).map((r) => ({
        id: r.id,
        date: isoDate(r.transaction_date),
        description: r.description,
        amount: { value: signedAmount(r), currency: r.currency },
        category: r.category ? { id: r.category.id, name: r.category.name, group: r.category.group } : null,
      })),
    };
  },
});

const amountField = z.number().refine((n) => n !== 0, 'amount cannot be 0')
  .describe('Signed amount: positive = money in (credit), negative = money out (debit).');

function amountBody(amount) {
  return amount > 0 ? { credit: amount, debit: null } : { credit: null, debit: Math.abs(amount) };
}

// Listing identity of a ticker (#134). One ticker can trade on several
// exchanges (NVD is Nvidia on Xetra and a 2x short ETF on Nasdaq); the MIC is
// what makes the holding price the right one.
const exchangeField = z.string().regex(/^[A-Za-z0-9]{2,10}$/).optional()
  .describe('ISO-10383 MIC of the listing (mic_code from search_ticker), e.g. "XETR". Pass it when the ticker trades on several exchanges.');
const isinField = z.string().regex(/^[A-Za-z]{2}[A-Za-z0-9]{9}[0-9]$/).optional()
  .describe('ISIN of the security, e.g. "US67066G1040".');

const createTransaction = defineTool({
  name: 'create_transaction',
  access: 'write',
  title: 'Create transaction',
  description:
    'Record a manual transaction. Same effect as adding it in the app: analytics and portfolio update and the '
    + 'category choice trains the classifier. Stock, ETF/fund and crypto categories (buys and sells) require '
    + 'assetQuantity and assetPrice (both > 0) and a ticker. Only in the built-in Funds category is the ticker '
    + 'optional (private / unlisted funds have none); ETFs always need one. All three are optional for manually '
    + 'valued investments.',
  input: {
    date: dateString('Transaction date'),
    accountId: intId('Account ID from list_accounts.'),
    categoryId: intId('Category ID from list_categories.'),
    description: z.string().min(1).max(500),
    amount: amountField,
    currency: currencyCode.describe('ISO currency of the amount, usually the account currency.'),
    details: z.string().max(1000).optional().describe('Free-text note.'),
    tags: z.array(z.string().min(1).max(100)).max(20).optional().describe('Tag names (created if new).'),
    ticker: z.string().max(30).optional(),
    assetQuantity: z.number().optional(),
    assetPrice: z.number().optional(),
    exchange: exchangeField,
    isin: isinField,
  },
  wraps: [{ method: 'POST', route: '/api/transactions' }],
  notFoundHint: `${HINTS.ACCOUNT_HINT} ${HINTS.CATEGORY_HINT}`,
  async handler(args, { api }) {
    await Promise.all([ensureAccount(api, args.accountId), ensureCategory(api, args.categoryId)]);
    const body = {
      transaction_date: args.date,
      accountId: args.accountId,
      categoryId: args.categoryId,
      description: args.description,
      currency: args.currency,
      ...amountBody(args.amount),
      ...(args.details !== undefined && { details: args.details }),
      ...(args.tags && { tags: args.tags }),
      ...(args.ticker && { ticker: args.ticker }),
      ...(args.assetQuantity !== undefined && { assetQuantity: args.assetQuantity }),
      ...(args.assetPrice !== undefined && { assetPrice: args.assetPrice }),
      ...(args.exchange && { exchange: args.exchange.toUpperCase() }),
      ...(args.isin && { isin: args.isin.toUpperCase() }),
    };
    const created = await api.post('/api/transactions', body);
    const rows = Array.isArray(created) ? created : [created];
    return { created: rows.map((t) => ({ id: t.id, date: isoDate(t.transaction_date), amount: { value: signedAmount(t), currency: t.currency }, categoryId: t.categoryId })) };
  },
});

const updateTransaction = defineTool({
  name: 'update_transaction',
  access: 'write',
  title: 'Update transaction',
  description:
    'Change fields of a transaction (only the ones you pass). Re-categorising here is identical to doing it in '
    + 'the app: it teaches the classifier and refreshes analytics. `tags` replaces the whole tag list. A stock, '
    + 'ETF/fund or crypto transaction must end up with assetQuantity and assetPrice (both > 0) and a ticker '
    + '(optional only in the built-in Funds category).',
  input: {
    transactionId: intId('Transaction ID from search_transactions.'),
    date: dateString('New date').optional(),
    accountId: intId('New account ID.').optional(),
    categoryId: intId('New category ID.').optional(),
    description: z.string().min(1).max(500).optional(),
    details: z.string().max(1000).nullable().optional(),
    amount: amountField.optional(),
    currency: currencyCode.optional(),
    tags: z.array(z.string().min(1).max(100)).max(20).optional().describe('Full list of tag names (replaces).'),
    ticker: z.string().max(30).optional(),
    assetQuantity: z.number().optional(),
    assetPrice: z.number().optional(),
    exchange: exchangeField,
    isin: isinField,
  },
  wraps: [
    { method: 'GET', route: '/api/transactions' },
    { method: 'PUT', route: '/api/transactions' },
  ],
  notFoundHint: TX_HINT,
  async handler(args, { api }) {
    const existing = await api.get('/api/transactions', { id: args.transactionId });
    const checks = [];
    if (args.accountId && args.accountId !== existing.accountId) checks.push(ensureAccount(api, args.accountId));
    if (args.categoryId && args.categoryId !== existing.categoryId) checks.push(ensureCategory(api, args.categoryId));
    await Promise.all(checks);

    const amount = args.amount !== undefined
      ? amountBody(args.amount)
      : { credit: num(existing.credit), debit: num(existing.debit) };
    // PUT replaces every field, so send the full record like the app's edit form.
    const body = {
      transaction_date: args.date ?? isoDate(existing.transaction_date),
      accountId: args.accountId ?? existing.accountId,
      categoryId: args.categoryId ?? existing.categoryId,
      description: args.description ?? existing.description,
      details: args.details !== undefined ? args.details : existing.details,
      currency: args.currency ?? existing.currency,
      ...amount,
      ticker: args.ticker ?? existing.ticker,
      assetQuantity: args.assetQuantity ?? num(existing.assetQuantity),
      assetPrice: args.assetPrice ?? num(existing.assetPrice),
      isin: args.isin ? args.isin.toUpperCase() : existing.isin,
      exchange: args.exchange ? args.exchange.toUpperCase() : existing.exchange,
      assetCurrency: existing.assetCurrency,
      ...(args.tags && { tags: args.tags }),
    };
    if (!body.credit && !body.debit) throw new ToolInputError('The transaction has no amount; pass amount.');
    const updated = await api.put('/api/transactions', body, { id: args.transactionId });
    return { updated: shapeTransaction(updated) };
  },
});

const BULK_MAX_IDS = 50;

const bulkUpdateTransactions = defineTool({
  name: 'bulk_update_transactions',
  access: 'write',
  title: 'Recategorise transactions in bulk',
  description:
    `Recategorise up to ${BULK_MAX_IDS} committed transactions in one call. All-or-nothing: if any ID is not `
    + 'found, or the target category or a row\'s current category is Investments or Debt, nothing changes. '
    + 'Category only: for tags or other fields use update_transaction. Trains the classifier for each changed '
    + 'row and refreshes analytics once. Rows already in the category are reported as `unchanged`.',
  input: {
    ids: z.array(z.number().int().positive()).min(1).max(BULK_MAX_IDS)
      .refine((ids) => new Set(ids).size === ids.length, 'ids must not contain duplicates')
      .describe(`1 to ${BULK_MAX_IDS} distinct transaction IDs from search_transactions.`),
    categoryId: intId('Target category ID from list_categories (not Investments or Debt).'),
  },
  wraps: [{ method: 'PATCH', route: '/api/transactions/bulk' }],
  notFoundHint: TX_HINT,
  async handler(args, { api }) {
    await ensureCategory(api, args.categoryId);
    const result = await api.patch('/api/transactions/bulk', { ids: args.ids, categoryId: args.categoryId });
    return { updated: result.updated, unchanged: result.unchanged, categoryId: args.categoryId };
  },
});

const deleteTransaction = defineTool({
  name: 'delete_transaction',
  access: 'write',
  destructive: true,
  title: 'Delete transaction',
  description: 'Permanently delete a transaction. A bank-synced source item goes back to the review queue.',
  input: { transactionId: intId('Transaction ID from search_transactions.') },
  wraps: [{ method: 'DELETE', route: '/api/transactions' }],
  notFoundHint: TX_HINT,
  async handler(args, { api }) {
    await api.del('/api/transactions', { id: args.transactionId });
    return { deleted: args.transactionId };
  },
});

const TOOLS = [
  searchTransactions, getMerchantHistory, createTransaction, updateTransaction, bulkUpdateTransactions, deleteTransaction,
];

export default TOOLS;
