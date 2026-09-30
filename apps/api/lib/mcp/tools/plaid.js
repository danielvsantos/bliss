import { z } from 'zod';
import { defineTool, cursorField, limitField, intId, stringId, pathId } from '../define.js';
import { ToolInputError, errorMessage } from '../errors.js';
import { mapWithConcurrency } from '../loopback.js';
import { pageArgs, pageMeta, num, isoDate } from '../shape.js';

/**
 * Plaid review queue (#89): bank-synced transactions waiting for the user to
 * approve their AI-suggested category. Connection management (linking,
 * status, accounts, sync logs) stays in the app.
 */

const QUEUE_HINT = 'Use get_plaid_review_queue to find review item IDs.';
const MAX_ITEMS = 50;
const CONCURRENCY = 10;

function shapeQueueItem(t) {
  const amount = num(t.amount);
  return {
    id: t.id,
    date: isoDate(t.date),
    description: t.merchantName || t.name,
    rawName: t.name,
    // Plaid amounts are positive for money out; flip to Bliss' sign convention.
    amount: { value: amount == null ? null : -amount, currency: t.isoCurrencyCode || null },
    account: t.accountName ?? null,
    institution: t.institutionName ?? null,
    suggestedCategory: t.suggestedCategory
      ? { id: t.suggestedCategoryId, name: t.suggestedCategory.name, group: t.suggestedCategory.group, type: t.suggestedCategory.type }
      : null,
    confidence: t.aiConfidence ?? null,
    classificationSource: t.classificationSource ?? null,
    status: t.promotionStatus,
    pending: t.pending ?? false,
    requiresEnrichment: t.requiresEnrichment ?? false,
    ...(t.processingError && { error: t.processingError }),
    plaidItemId: t.plaidItemId,
  };
}

const getPlaidReviewQueue = defineTool({
  name: 'get_plaid_review_queue',
  access: 'read',
  title: 'Get bank-sync review queue',
  description:
    'Bank-synced transactions waiting for review, each with an AI-suggested category and confidence (0-1). '
    + 'Default status CLASSIFIED = ready to approve. FAILED = classification failed (retry with '
    + 'requeue_plaid_transactions). SKIPPED = the user skipped them. Amounts: negative = money out. '
    + '`summary` counts items per status. Approve or re-categorise with review_plaid_transactions.',
  input: {
    status: z.enum(['CLASSIFIED', 'PENDING', 'SKIPPED', 'FAILED', 'PROMOTED', 'ALL']).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    maxConfidence: z.number().min(0).max(1).optional(),
    categoryId: intId('Only items suggested into this category.').optional(),
    uncategorized: z.boolean().optional().describe('Only items without a suggested category.'),
    limit: limitField(50),
    cursor: cursorField,
  },
  wraps: [{ method: 'GET', route: '/api/plaid/transactions' }],
  async handler(args, { api }) {
    const p = pageArgs(args, 50);
    const data = await api.get('/api/plaid/transactions', {
      promotionStatus: args.status,
      minConfidence: args.minConfidence,
      maxConfidence: args.maxConfidence,
      categoryId: args.categoryId,
      uncategorized: args.uncategorized ? 'true' : undefined,
      page: p.page,
      limit: p.limit,
    });
    const total = data.pagination?.total ?? 0;
    const s = data.summary || {};
    return {
      items: (data.transactions || []).map(shapeQueueItem),
      total,
      ...pageMeta(p, total),
      summary: {
        classified: s.classified, pending: s.pending, promoted: s.promoted,
        skipped: s.skipped, failed: s.failed, seedHeld: s.seedHeld,
      },
    };
  },
});

const ACTION_BODY = {
  approve: (item) => ({ promotionStatus: 'PROMOTED', ...(item.categoryId && { suggestedCategoryId: item.categoryId }) }),
  recategorize: (item) => ({ suggestedCategoryId: item.categoryId }),
  skip: () => ({ promotionStatus: 'SKIPPED' }),
  unskip: () => ({ promotionStatus: 'CLASSIFIED' }),
};

const reviewPlaidTransactions = defineTool({
  name: 'review_plaid_transactions',
  access: 'write',
  title: 'Review bank-sync items',
  description:
    'Act on review queue items. `items` (max 50): approve (creates the transaction; optional categoryId '
    + 'overrides the suggestion), recategorize (categoryId required, stays in the queue), skip, or unskip. '
    + 'Investment categories need ticker, assetQuantity and assetPrice to approve. `bulkPromote` approves many '
    + 'at once: every CLASSIFIED item with confidence >= minConfidence, or exactly the given ids. '
    + 'Pass either items or bulkPromote.',
  input: {
    items: z.array(z.object({
      id: stringId('Review item ID from get_plaid_review_queue.'),
      action: z.enum(['approve', 'recategorize', 'skip', 'unskip']),
      categoryId: z.number().int().positive().optional(),
      ticker: z.string().max(30).optional(),
      assetQuantity: z.number().optional(),
      assetPrice: z.number().optional(),
      details: z.string().max(1000).optional(),
    })).max(MAX_ITEMS).optional(),
    bulkPromote: z.object({
      minConfidence: z.number().min(0).max(1).optional().describe('Approve items at or above this confidence.'),
      ids: z.array(z.string().min(1).max(100)).max(500).optional().describe('Approve exactly these items.'),
      categoryId: z.number().int().positive().optional().describe('Only items suggested into this category.'),
      overrideCategoryId: z.number().int().positive().optional().describe('File every approved item under this category.'),
    }).optional(),
  },
  wraps: [
    { method: 'PUT', route: '/api/plaid/transactions/[id]' },
    { method: 'POST', route: '/api/plaid/transactions/bulk-promote' },
  ],
  notFoundHint: QUEUE_HINT,
  async handler(args, { api }) {
    if (!args.items?.length === !args.bulkPromote) {
      throw new ToolInputError('Pass either items or bulkPromote (not both).');
    }
    if (args.bulkPromote) {
      const b = args.bulkPromote;
      if (b.minConfidence == null && !b.ids?.length) {
        throw new ToolInputError('bulkPromote needs minConfidence or ids.');
      }
      const result = await api.post('/api/plaid/transactions/bulk-promote', {
        ...(b.ids?.length ? { transactionIds: b.ids } : { minConfidence: b.minConfidence }),
        ...(b.categoryId && { categoryId: b.categoryId }),
        ...(b.overrideCategoryId && { overrideCategoryId: b.overrideCategoryId }),
      });
      return { promoted: result.promoted, skipped: result.skipped, errors: result.errors };
    }

    for (const item of args.items) {
      if (item.action === 'recategorize' && !item.categoryId) {
        throw new ToolInputError(`recategorize needs categoryId (item ${item.id}).`);
      }
    }
    const results = await mapWithConcurrency(args.items, CONCURRENCY, async (item) => {
      const body = {
        ...ACTION_BODY[item.action](item),
        ...(item.ticker && { ticker: item.ticker }),
        ...(item.assetQuantity !== undefined && { assetQuantity: item.assetQuantity }),
        ...(item.assetPrice !== undefined && { assetPrice: item.assetPrice }),
        ...(item.details !== undefined && { details: item.details }),
      };
      try {
        const updated = await api.put(`/api/plaid/transactions/${encodeURIComponent(item.id)}`, body);
        return { id: item.id, ok: true, status: updated?.promotionStatus ?? null };
      } catch (err) {
        return { id: item.id, ok: false, error: errorMessage(err, { tool: 'review_plaid_transactions', notFoundHint: QUEUE_HINT }) };
      }
    });
    return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  },
});

const requeuePlaidTransactions = defineTool({
  name: 'requeue_plaid_transactions',
  access: 'write',
  title: 'Re-queue bank-sync items',
  description:
    '`failedIds`: retry classification of FAILED items (max 50). `allSkipped: true`: send every SKIPPED item '
    + 'back to the review queue (optionally only for one plaidItemId).',
  input: {
    failedIds: z.array(pathId()).max(MAX_ITEMS).optional(),
    allSkipped: z.boolean().optional(),
    plaidItemId: z.string().max(100).optional().describe('Bank connection ID (plaidItemId from the queue items).'),
  },
  wraps: [
    { method: 'POST', route: '/api/plaid/transactions/[id]/retry' },
    { method: 'POST', route: '/api/plaid/transactions/bulk-requeue' },
  ],
  notFoundHint: QUEUE_HINT,
  async handler(args, { api }) {
    if (!args.failedIds?.length && !args.allSkipped) {
      throw new ToolInputError('Pass failedIds and/or allSkipped: true.');
    }
    const out = {};
    if (args.failedIds?.length) {
      out.retried = await mapWithConcurrency(args.failedIds, CONCURRENCY, async (id) => {
        try {
          await api.post(`/api/plaid/transactions/${encodeURIComponent(id)}/retry`);
          return { id, ok: true };
        } catch (err) {
          return { id, ok: false, error: errorMessage(err, { tool: 'requeue_plaid_transactions', notFoundHint: QUEUE_HINT }) };
        }
      });
    }
    if (args.allSkipped) {
      const result = await api.post('/api/plaid/transactions/bulk-requeue', { plaidItemId: args.plaidItemId });
      out.requeued = result.updated;
    }
    return out;
  },
});

const listPlaidSeeds = defineTool({
  name: 'list_plaid_seeds',
  access: 'read',
  title: 'List bank-sync seeds',
  description:
    'After a new bank connection, its most frequent merchants are held back as "seeds" for the user to confirm '
    + 'once. Lists them for one plaidItemId (from get_plaid_review_queue items or the notifications summary).',
  input: {
    plaidItemId: z.string().min(1).max(100),
    limit: z.number().int().min(1).max(50).optional().describe('Max seeds (default 15).'),
  },
  wraps: [{ method: 'GET', route: '/api/plaid/transactions/seeds' }],
  notFoundHint: 'Use get_plaid_review_queue to find plaidItemId values.',
  async handler(args, { api }) {
    const seeds = await api.get('/api/plaid/transactions/seeds', { plaidItemId: args.plaidItemId, limit: args.limit });
    return {
      items: (seeds || []).map((s) => ({
        description: s.description,
        rawName: s.rawName,
        count: s.count,
        suggestedCategory: s.suggestedCategory
          ? { id: s.suggestedCategoryId, name: s.suggestedCategory.name, group: s.suggestedCategory.group }
          : null,
        confidence: s.aiConfidence ?? null,
        reasoning: s.classificationReasoning ?? null,
      })),
    };
  },
});

const confirmPlaidSeeds = defineTool({
  name: 'confirm_plaid_seeds',
  access: 'write',
  title: 'Confirm bank-sync seeds',
  description:
    'Confirm categories for seeds from list_plaid_seeds. Each confirmed seed trains the classifier and releases '
    + 'the held transactions of that merchant.',
  input: {
    plaidItemId: z.string().min(1).max(100),
    seeds: z.array(z.object({
      description: z.string().min(1).max(500),
      rawName: z.string().max(500).optional(),
      categoryId: z.number().int().positive(),
    })).min(1).max(MAX_ITEMS),
  },
  wraps: [{ method: 'POST', route: '/api/plaid/transactions/confirm-seeds' }],
  notFoundHint: 'Use get_plaid_review_queue to find plaidItemId values.',
  async handler(args, { api }) {
    const result = await api.post('/api/plaid/transactions/confirm-seeds', {
      plaidItemId: args.plaidItemId,
      seeds: args.seeds.map((s) => ({ description: s.description, rawName: s.rawName, confirmedCategoryId: s.categoryId })),
    });
    return { confirmed: result.confirmed, promoted: result.promoted };
  },
});

const TOOLS = [getPlaidReviewQueue, reviewPlaidTransactions, requeuePlaidTransactions, listPlaidSeeds, confirmPlaidSeeds];

export default TOOLS;
