import { z } from 'zod';
import { defineTool, cursorField, limitField, intId } from '../define.js';
import { ToolInputError } from '../errors.js';
import { pageArgs, pageMeta, money, isoDate } from '../shape.js';

/**
 * Subscriptions & recurring charges (#89). A subscription's ID is its
 * merchant hash (`descriptionHash` in the REST API). The maintenance-only
 * `fullScan` action is not exposed.
 */

const SUB_HINT = 'Use list_subscriptions with view "all" to find subscription IDs.';
const SUBSCRIPTION_ACTIONS = ['confirm', 'dismiss', 'restore', 'setCadence', 'rename', 'merge', 'unmerge', 'refresh'];

function shapeSubscription(s, displayCurrency) {
  return {
    subscriptionId: s.descriptionHash,
    merchant: s.merchantLabel,
    category: s.category ? { id: s.category.id, name: s.category.name } : null,
    state: s.state,
    status: s.status,
    cadence: s.cadence,
    amount: money(s.amount, s.currency),
    amountDisplay: money(s.amountInDisplayCurrency, displayCurrency),
    monthlyAmountDisplay: money(s.monthlyAmount, displayCurrency),
    occurrences: s.occurrenceCount,
    firstChargedAt: isoDate(s.firstChargedAt),
    lastChargedAt: isoDate(s.lastChargedAt),
    nextExpectedAt: isoDate(s.nextExpectedAt),
    ...(s.mergedIntoHash && { mergedInto: { subscriptionId: s.mergedIntoHash, merchant: s.mergedIntoLabel } }),
    transactionIds: (s.contributingTransactionIds || []).slice(0, 12),
  };
}

const listSubscriptions = defineTool({
  name: 'list_subscriptions',
  access: 'read',
  title: 'List subscriptions',
  description:
    'Detected recurring charges, one per merchant: cadence, amount, next expected charge and whether it is still '
    + 'ACTIVE or LAPSED. state DETECTED = needs the user\'s review, CONFIRMED = accepted, DISMISSED = not a '
    + 'subscription. `summary` has the monthly and annual recurring spend in the display currency. view "all" '
    + 'also shows dismissed and merged rows.',
  input: {
    view: z.enum(['active', 'lapsed', 'all']).optional(),
    categoryId: intId('Only this category.').optional(),
    limit: limitField(25),
    cursor: cursorField,
  },
  wraps: [{ method: 'GET', route: '/api/subscriptions' }],
  async handler(args, { api }) {
    const p = pageArgs(args, 25);
    const data = await api.get('/api/subscriptions', {
      view: args.view, categoryId: args.categoryId, page: p.page, limit: p.limit,
    });
    return {
      displayCurrency: data.displayCurrency,
      summary: data.summary,
      lastDetectedAt: data.lastDetectedAt,
      items: (data.items || []).map((s) => shapeSubscription(s, data.displayCurrency)),
      total: data.total,
      ...pageMeta(p, data.total),
    };
  },
});

const updateSubscription = defineTool({
  name: 'update_subscription',
  access: 'write',
  destructive: true,
  title: 'Update a subscription',
  description:
    'confirm (subscriptionId, or transactionId to mark a transaction\'s merchant as recurring), dismiss (not a '
    + 'subscription), restore (undo dismiss), setCadence (cadence), rename (merchantLabel), merge '
    + '(subscriptionId folded into targetSubscriptionId, e.g. two descriptors of one merchant), unmerge, refresh '
    + '(re-run detection; at most every 30 minutes).',
  input: {
    action: z.enum(SUBSCRIPTION_ACTIONS),
    subscriptionId: z.string().min(1).max(200).optional(),
    transactionId: intId('confirm only: a transaction of the merchant.').optional(),
    cadence: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL']).optional(),
    merchantLabel: z.string().min(1).max(140).optional(),
    targetSubscriptionId: z.string().min(1).max(200).optional().describe('merge only: the row to keep.'),
  },
  wraps: [{ method: 'POST', route: '/api/subscriptions' }],
  notFoundHint: SUB_HINT,
  async handler(args, { api }) {
    const need = (field) => {
      if (!args[field]) throw new ToolInputError(`${args.action} requires ${field}.`);
      return args[field];
    };
    let body;
    switch (args.action) {
      case 'confirm':
        if (!args.subscriptionId && !args.transactionId) {
          throw new ToolInputError('confirm requires subscriptionId or transactionId.');
        }
        body = args.transactionId ? { transactionId: args.transactionId } : { descriptionHash: args.subscriptionId };
        break;
      case 'dismiss':
      case 'restore':
      case 'unmerge':
        body = { descriptionHash: need('subscriptionId') };
        break;
      case 'setCadence':
        body = { descriptionHash: need('subscriptionId'), cadence: need('cadence') };
        break;
      case 'rename':
        body = { descriptionHash: need('subscriptionId'), merchantLabel: need('merchantLabel') };
        break;
      case 'merge':
        body = { sourceDescriptionHash: need('subscriptionId'), targetDescriptionHash: need('targetSubscriptionId') };
        break;
      default:
        body = {};
    }
    const result = await api.post('/api/subscriptions', { action: args.action, ...body });
    if (result && typeof result === 'object' && result.descriptionHash) {
      const { descriptionHash, ...rest } = result;
      return { action: args.action, subscriptionId: descriptionHash, merchant: rest.merchantLabel, state: rest.state, cadence: rest.cadence };
    }
    return { action: args.action, ...(result || {}) };
  },
});

const TOOLS = [listSubscriptions, updateSubscription];

export default TOOLS;
