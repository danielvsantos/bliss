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
    ...(t.ticker && { ticker: t.ticker, assetQuantity: num(t.assetQuantity), assetPrice: num(t.assetPrice) }),
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
  };
}

const searchTransactions = defineTool({
  name: 'search_transactions',
  access: 'read',
  title: 'Search transactions',
  description:
    'Search committed transactions, newest first. Amounts are signed: positive = money in (credit), negative = '
    + 'money out (debit), in the transaction\'s own currency. Filter by date range, account, category, category '
    + 'group/type, tag, currency or source. Descriptions are encrypted at rest and cannot be searched: to find a '
    + 'merchant use get_merchant_history, or narrow by date/category and read the page. `totals` (sum of the whole '
    + 'filtered set) is only returned when `currency` is set.',
  input: {
    from: dateString('Start date, inclusive').optional(),
    to: dateString('End date, inclusive').optional(),
    accountId: intId('Account ID from list_accounts.').optional(),
    categoryId: intId('Category ID from list_categories.').optional(),
    categoryGroup: z.string().max(100).optional().describe('Category group, e.g. "Food".'),
    categoryType: z.string().max(100).optional().describe('Category type, e.g. "Essentials" or "Income".'),
    tag: z.string().max(100).optional().describe('Tag name or tag ID.'),
    currency: currencyCode.optional().describe('Only transactions in this currency.'),
    source: z.enum(['MANUAL', 'PLAID', 'CSV']).optional(),
    limit: limitField(50),
    cursor: cursorField,
  },
  wraps: [{ method: 'GET', route: '/api/transactions' }],
  async handler(args, { api }) {
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

const createTransaction = defineTool({
  name: 'create_transaction',
  access: 'write',
  title: 'Create transaction',
  description:
    'Record a manual transaction. Same effect as adding it in the app: analytics and portfolio update and the '
    + 'category choice trains the classifier. Stock, ETF/fund and crypto categories (buys and sells) require '
    + 'ticker, assetQuantity and assetPrice (both > 0); they are optional for manually valued investments.',
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
    + 'ETF/fund or crypto transaction must end up with ticker, assetQuantity and assetPrice (both > 0).',
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
      isin: existing.isin,
      exchange: existing.exchange,
      assetCurrency: existing.assetCurrency,
      ...(args.tags && { tags: args.tags }),
    };
    if (!body.credit && !body.debit) throw new ToolInputError('The transaction has no amount; pass amount.');
    const updated = await api.put('/api/transactions', body, { id: args.transactionId });
    return { updated: shapeTransaction(updated) };
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

const TOOLS = [searchTransactions, getMerchantHistory, createTransaction, updateTransaction, deleteTransaction];

export default TOOLS;
