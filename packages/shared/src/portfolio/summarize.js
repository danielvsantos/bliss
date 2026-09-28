/**
 * Passive income summary for AI insights (#80).
 *
 * `summarize()` shrinks a `project()` result (plus the trailing actuals and
 * essential spending the caller loads) into the small, bounded object the
 * insights pipeline puts in the prompt. Pure: no I/O.
 *
 * Stability: the insights pipeline skips a run when the hash of its input
 * hasn't changed, so every amount is rounded to whole units of the display
 * currency and every percentage to 1 decimal, arrays are bounded and their
 * order is deterministic (ties broken by label).
 */

/** Max entries per array in the summary (keeps the prompt small). */
export const SUMMARY_LIMITS = { topContributors: 3, endingItems: 5, missingLabels: 5, assumedRateLabels: 3 };

/** Asset classes whose dividends `DIVIDEND_OPPORTUNITY` covers (equities only). */
const EQUITY_DIVIDEND_CLASSES = ['STOCK', 'ETF'];

const BOND_TYPES = ['FIXED_COUPON', 'FLOATING_COUPON', 'INFLATION_LINKED'];

/** Income types whose projection depends on a rate the user assumed. */
const ASSUMED_RATE_TYPES = ['FLOATING_COUPON', 'INFLATION_LINKED'];

const PAYMENTS_PER_YEAR = { WEEKLY: 52, MONTHLY: 12, QUARTERLY: 4, SEMIANNUAL: 2, ANNUAL: 1 };

const BUCKETS = ['dividend', 'coupon', 'rent', 'interest', 'other'];

const round0 = (n) => Math.round(Number(n) || 0);
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const pctOf = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : null);
const byLabel = (a, b) => String(a.label).localeCompare(String(b.label));

/** Last day (inclusive, 'YYYY-MM-DD') of the 12 months starting on `windowStart`. */
function next12End(windowStart) {
  const d = new Date(`${windowStart}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 12, 0)).toISOString().slice(0, 10);
}

function endReason(item) {
  if (BOND_TYPES.includes(item.incomeType)) return 'MATURITY';
  if (item.incomeType === 'RENT') return 'LEASE_END';
  return 'END_DATE';
}

/** Current monthly run rate of an item (0 for one-off / at-maturity payments). */
function monthlyRunRate(item) {
  const perYear = PAYMENTS_PER_YEAR[item.frequency];
  if (!perYear || item.amountPerPayment == null) return 0;
  return (Number(item.amountPerPayment) * perYear) / 12;
}

/**
 * Summarize a projection for the insights prompt.
 *
 * @param {Object} projection           `project()` result (horizon ≥ 12)
 * @param {Array<{month: string, total: number}>|number} [actuals]
 *                                       trailing 12 months of actual passive income (or their sum)
 * @param {number|null} [essentials]    trailing 12 months of essential spending (positive)
 * @returns {Object} see docs/specs/backend/15-insights-engine.md → Passive income summary
 */
export function summarize(projection, actuals = [], essentials = null) {
  const totals = projection?.totals || {};
  const items = Array.isArray(projection?.items) ? projection.items : [];
  const monthly = Array.isArray(projection?.monthly) ? projection.monthly.slice(0, 12) : [];

  const total = Number(totals.next12mIncome) || 0;
  const investment = Number(totals.next12mInvestmentIncome) || 0;
  const other = Number(totals.next12mOtherIncome) || 0;

  const bySource = {};
  for (const bucket of BUCKETS) bySource[bucket] = round0(monthly.reduce((s, m) => s + (Number(m[bucket]) || 0), 0));

  const trailing = Array.isArray(actuals)
    ? actuals.reduce((s, a) => s + (Number(a?.total) || 0), 0)
    : Number(actuals) || 0;
  const essentialSpend = Number(essentials) > 0 ? Number(essentials) : null;

  // Top contributors over the next 12 months, per holding: the same symbol
  // held in several accounts is one contributor (`project().groups`, #83),
  // streams stay individual.
  const holdings = Array.isArray(projection?.groups)
    ? projection.groups.map((g) => ({ label: g.label, kind: 'ASSET', next12mTotal: g.next12mTotal }))
    : items.filter((i) => i.kind === 'ASSET');
  const earning = [...holdings, ...items.filter((i) => i.kind === 'STREAM')]
    .filter((i) => (Number(i.next12mTotal) || 0) > 0)
    .sort((a, b) => b.next12mTotal - a.next12mTotal || byLabel(a, b));
  const topContributors = earning.slice(0, SUMMARY_LIMITS.topContributors).map((i) => ({
    label: i.label,
    kind: i.kind,
    next12m: round0(i.next12mTotal),
    sharePct: pctOf(i.next12mTotal, total),
  }));

  // Income whose source stops paying inside the 12-month window
  const windowEnd = projection?.window?.start ? next12End(projection.window.start) : null;
  const asOf = projection?.asOf || null;
  const ending = windowEnd
    ? items
        .filter((i) => i.endDate && i.status !== 'ENDED' && (!asOf || i.endDate >= asOf) && i.endDate <= windowEnd)
        .sort((a, b) => (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : byLabel(a, b)))
    : [];
  const monthlyLost = ending.reduce((s, i) => s + monthlyRunRate(i), 0);

  // Coverage of income-capable holdings with terms (streams are always configured)
  const coverage = totals.coverage || { configured: 0, total: 0 };
  const missing = Array.isArray(projection?.missing) ? projection.missing : [];
  const missingLabels = [...new Set(missing.map((m) => m.symbol || m.label).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)))
    .slice(0, SUMMARY_LIMITS.missingLabels);

  const assumed = items
    .filter((i) => ASSUMED_RATE_TYPES.includes(i.incomeType))
    .sort(byLabel);

  const dividendsNext12m = items
    .filter((i) => i.kind === 'ASSET' && i.incomeType === 'DIVIDEND' && EQUITY_DIVIDEND_CLASSES.includes(i.assetClass))
    .reduce((s, i) => s + (Number(i.next12mTotal) || 0), 0);

  return {
    next12m: { total: round0(total), investment: round0(investment), other: round0(other), bySource },
    trailing12mActual: round0(trailing),
    trailing12mEssentials: essentialSpend != null ? round0(essentialSpend) : null,
    essentialsCoveragePct: essentialSpend != null ? pctOf(total, essentialSpend) : null,
    essentialsCoverageInvestmentPct: essentialSpend != null ? pctOf(investment, essentialSpend) : null,
    topContributors,
    largestSharePct: earning.length ? pctOf(earning[0].next12mTotal, total) : null,
    endingWithin12m: {
      monthlyAmountLost: round0(monthlyLost),
      sharePct: total > 0 ? Math.min(100, pctOf(monthlyLost * 12, total)) : null,
      items: ending.slice(0, SUMMARY_LIMITS.endingItems).map((i) => ({
        label: i.label,
        endDate: i.endDate,
        reason: endReason(i),
      })),
    },
    coverage: {
      configured: Number(coverage.configured) || 0,
      total: Number(coverage.total) || 0,
      pct: coverage.total > 0 ? pctOf(coverage.configured, coverage.total) : null,
      missingLabels,
    },
    assumedRates: {
      count: assumed.length,
      labels: assumed.slice(0, SUMMARY_LIMITS.assumedRateLabels).map((i) => i.label),
    },
    streamCount: items.filter((i) => i.kind === 'STREAM').length,
    dividendsNext12m: round0(dividendsNext12m),
  };
}
