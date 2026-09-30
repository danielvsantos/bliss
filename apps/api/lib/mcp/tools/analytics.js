import { z } from 'zod';
import { defineTool, cursorField, limitField, currencyCode } from '../define.js';
import { ToolInputError } from '../errors.js';
import { offsetArgs, offsetMeta, paginate, isoDate } from '../shape.js';

/** Analytics, insights and notifications (#89). */

const PERIOD_FORMATS = {
  month: { re: /^\d{4}-(0[1-9]|1[0-2])$/, example: '2026-03' },
  quarter: { re: /^\d{4}-Q[1-4]$/, example: '2026-Q1' },
  year: { re: /^\d{4}$/, example: '2026' },
};

/** `{ view, from, to }` → the analytics routes' period query parameters. */
export function periodQuery(view, from, to) {
  const fmt = PERIOD_FORMATS[view];
  for (const [label, value] of [['from', from], ['to', to]]) {
    if (!fmt.re.test(value)) {
      throw new ToolInputError(`${label} must look like ${fmt.example} for view "${view}".`);
    }
  }
  if (from > to) throw new ToolInputError('from must not be after to.');
  if (view === 'month') return { startMonth: from, endMonth: to };
  if (view === 'quarter') return { startQuarter: from, endQuarter: to };
  const years = [];
  for (let y = Number(from); y <= Number(to); y += 1) years.push(y);
  if (years.length > 50) throw new ToolInputError('At most 50 years at once.');
  return { years };
}

const round2 = (n) => Math.round(n * 100) / 100;

const periodInput = {
  view: z.enum(['month', 'quarter', 'year']).describe('Period granularity.'),
  from: z.string().describe('First period: "YYYY-MM" (month), "YYYY-Qn" (quarter) or "YYYY" (year).'),
  to: z.string().describe('Last period, same format as from (inclusive).'),
  currency: currencyCode.optional()
    .describe('Currency the totals are expressed in (default: the display currency from get_reference_data).'),
};

async function displayCurrency(api, currency) {
  if (currency) return currency;
  const settings = await api.get('/api/tenants/settings');
  return settings?.portfolioCurrency || 'USD';
}

const getSpendingSummary = defineTool({
  name: 'get_spending_summary',
  access: 'read',
  title: 'Get income and spending summary',
  description:
    'Income and spending totals per period, by category type and category group, from the same pre-computed '
    + 'analytics as the Analytics page (all currencies converted into one). `in` = credits, `out` = debits '
    + '(positive numbers), `net` = in - out. For a single category (not group), sum search_transactions instead.',
  input: {
    ...periodInput,
    types: z.array(z.string().max(100)).max(20).optional().describe('Only these category types, e.g. ["Essentials"].'),
    groups: z.array(z.string().max(100)).max(50).optional().describe('Only these category groups, e.g. ["Food"].'),
    countries: z.array(z.string().max(3)).max(20).optional().describe('Only accounts in these countries (ISO codes).'),
    limit: limitField(100),
    cursor: cursorField,
  },
  wraps: [
    { method: 'GET', route: '/api/analytics' },
    { method: 'GET', route: '/api/tenants/settings' },
  ],
  async handler(args, { api }) {
    const period = periodQuery(args.view, args.from, args.to);
    const currency = await displayCurrency(api, args.currency);
    const data = await api.get('/api/analytics', {
      view: args.view, currency, ...period, types: args.types, groups: args.groups, countries: args.countries,
    });

    const rows = [];
    const totals = [];
    for (const periodKey of Object.keys(data.data || {}).sort()) {
      for (const [type, groups] of Object.entries(data.data[periodKey])) {
        const sum = { in: 0, out: 0, net: 0 };
        for (const [group, v] of Object.entries(groups)) {
          rows.push({ period: periodKey, type, group, in: round2(v.credit), out: round2(v.debit), net: round2(v.balance) });
          sum.in += v.credit;
          sum.out += v.debit;
          sum.net += v.balance;
        }
        totals.push({ period: periodKey, type, in: round2(sum.in), out: round2(sum.out), net: round2(sum.net) });
      }
    }
    const page = paginate(rows, args, 100);
    return { currency, view: args.view, totalsByType: totals, rows: page.items, totalRows: page.total, hasMore: page.hasMore, nextCursor: page.nextCursor };
  },
});

const getTagSummary = defineTool({
  name: 'get_tag_summary',
  access: 'read',
  title: 'Get tag summary',
  description:
    'Income and spending for tagged transactions (e.g. a trip), per tag and period, broken down by category. '
    + 'Amounts in one currency; `out` = spending, `in` = income.',
  input: {
    tagIds: z.array(z.number().int().positive()).min(1).max(20).describe('Tag IDs from list_tags.'),
    ...periodInput,
  },
  wraps: [
    { method: 'GET', route: '/api/analytics/tags' },
    { method: 'GET', route: '/api/tenants/settings' },
  ],
  async handler(args, { api }) {
    const period = periodQuery(args.view, args.from, args.to);
    const currency = await displayCurrency(api, args.currency);
    const data = await api.get('/api/analytics/tags', { tagIds: args.tagIds, view: args.view, currency, ...period });
    const tags = [];
    for (const [tagId, periods] of Object.entries(data.tags || {})) {
      const rows = [];
      let totalIn = 0;
      let totalOut = 0;
      for (const periodKey of Object.keys(periods).sort()) {
        for (const [type, groups] of Object.entries(periods[periodKey])) {
          for (const [group, categories] of Object.entries(groups)) {
            for (const [category, v] of Object.entries(categories)) {
              rows.push({ period: periodKey, type, group, category, in: round2(v.credit), out: round2(v.debit), net: round2(v.balance) });
              totalIn += v.credit;
              totalOut += v.debit;
            }
          }
        }
      }
      tags.push({ tagId: Number(tagId), totalIn: round2(totalIn), totalOut: round2(totalOut), rows: rows.slice(0, 100), rowsTruncated: rows.length > 100 });
    }
    return { currency, view: args.view, tags };
  },
});

const TIERS = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PORTFOLIO'];
const INSIGHT_CATEGORIES = ['SPENDING', 'INCOME', 'SAVINGS', 'PORTFOLIO', 'DEBT', 'NET_WORTH'];

const listInsights = defineTool({
  name: 'list_insights',
  access: 'read',
  title: 'List insights',
  description:
    'AI-generated financial insights: tiers MONTHLY, QUARTERLY and ANNUAL health checks, and PORTFOLIO notes '
    + '(generated weekly; there is no WEEKLY tier), '
    + 'most important first. Dismissed insights are hidden unless includeDismissed is true.',
  input: {
    tier: z.enum(TIERS).optional(),
    category: z.enum(INSIGHT_CATEGORIES).optional(),
    severity: z.enum(['INFO', 'WARNING', 'POSITIVE', 'CRITICAL']).optional(),
    periodKey: z.string().max(20).optional().describe('e.g. "2026-03" (MONTHLY), "2026-Q1" (QUARTERLY), "2025" (ANNUAL), "2026-W14" (PORTFOLIO).'),
    includeDismissed: z.boolean().optional(),
    limit: limitField(20),
    cursor: cursorField,
  },
  wraps: [{ method: 'GET', route: '/api/insights' }],
  async handler(args, { api }) {
    const o = offsetArgs(args, 20);
    const data = await api.get('/api/insights', {
      tier: args.tier,
      category: args.category,
      severity: args.severity,
      periodKey: args.periodKey,
      includeDismissed: args.includeDismissed ? 'true' : undefined,
      limit: o.limit,
      offset: o.offset,
    });
    return {
      items: (data.insights || []).map((i) => ({
        id: i.id,
        tier: i.tier,
        periodKey: i.periodKey,
        category: i.category,
        lens: i.lens,
        severity: i.severity,
        priority: i.priority,
        title: i.title,
        body: i.body,
        suggestedAction: i.metadata?.suggestedAction ?? null,
        date: isoDate(i.date),
        dismissed: i.dismissed,
      })),
      total: data.total,
      ...offsetMeta(o, data.total),
      latestByTier: data.tierSummary,
    };
  },
});

const generateInsights = defineTool({
  name: 'generate_insights',
  access: 'write',
  title: 'Generate insights',
  description:
    'Start AI insight generation for a period (runs in the background; check list_insights in a few minutes). '
    + 'Defaults to the current month/quarter/year. Unchanged data is skipped unless force is true.',
  input: {
    tier: z.enum(TIERS),
    year: z.number().int().min(2000).max(2100).optional(),
    month: z.number().int().min(1).max(12).optional().describe('MONTHLY only.'),
    quarter: z.number().int().min(1).max(4).optional().describe('QUARTERLY only.'),
    force: z.boolean().optional(),
  },
  wraps: [{ method: 'POST', route: '/api/insights' }],
  async handler(args, { api }) {
    const data = await api.post('/api/insights', {
      tier: args.tier, year: args.year, month: args.month, quarter: args.quarter, force: args.force === true,
    });
    return { started: true, tier: data?.tier ?? args.tier, message: 'Generation started. Results appear in list_insights.' };
  },
});

const dismissInsight = defineTool({
  name: 'dismiss_insight',
  access: 'write',
  title: 'Dismiss or restore an insight',
  description: 'Hide an insight (dismissed: true, the default) or bring it back (dismissed: false).',
  input: {
    insightId: z.string().min(1).max(100).describe('Insight ID from list_insights.'),
    dismissed: z.boolean().optional(),
  },
  wraps: [{ method: 'PUT', route: '/api/insights' }],
  notFoundHint: 'Use list_insights to find insight IDs.',
  async handler(args, { api }) {
    const updated = await api.put('/api/insights', { insightId: args.insightId, dismissed: args.dismissed ?? true });
    return { id: updated.id, dismissed: updated.dismissed };
  },
});

const getNotificationsSummary = defineTool({
  name: 'get_notifications_summary',
  access: 'read',
  title: 'Get notifications summary',
  description:
    'What needs the user\'s attention: pending review items (bank sync + imports), failed classifications, '
    + 'bank connections needing action, new insights and onboarding steps.',
  input: {},
  wraps: [{ method: 'GET', route: '/api/notifications/summary' }],
  async handler(_args, { api }) {
    const data = await api.get('/api/notifications/summary');
    return {
      totalUnseen: data.totalUnseen ?? null,
      signals: (data.signals || []).map((s) => ({ type: s.type, count: s.count, isNew: s.isNew ?? false })),
    };
  },
});


const TOOLS = [getSpendingSummary, getTagSummary, listInsights, generateInsights, dismissInsight, getNotificationsSummary];

export default TOOLS;
