const crypto = require('crypto');
const prisma = require('../../prisma/prisma.js');
const logger = require('../utils/logger');
const { generateInsightContent } = require('./llm');
const { buildSystemBlocks, buildUserMessage } = require('./insightPrompts/builder');
const { insightArraySchema } = require('./insightPrompts/schema');
// IMPORTANT: the insights engine is a pure read consumer. It must NEVER
// import getOrCreateCurrencyRate — that helper is a write-through cache that
// hits CurrencyLayer and inserts rows into CurrencyRate on a miss. Only the
// valuation pipeline (portfolioWorker, price-fetcher) is authorized to
// populate CurrencyRate. Reads from this service must use getRatesForDateRange
// + the in-memory lookupCurrencyRate() fallback defined below.
// See insights-v2 refactor: docs/specs/backend/15-insights-engine.md
const { getRatesForDateRange } = require('./currencyService');
const { checkTierCompleteness, getPeriodKey, getQuarterMonths, getQuarterFromMonth } = require('./dataCompletenessService');

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_TIERS = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PORTFOLIO'];

const VALID_CATEGORIES = ['SPENDING', 'INCOME', 'SAVINGS', 'PORTFOLIO', 'DEBT', 'NET_WORTH'];

const VALID_SEVERITIES = ['POSITIVE', 'INFO', 'WARNING', 'CRITICAL'];

const VALID_ACTION_TYPES = [
  'BUDGET_OPTIMIZATION', 'TAX_EFFICIENCY', 'PORTFOLIO_REBALANCE',
  'DEBT_REDUCTION', 'SAVINGS_GOAL', 'TRAVEL_PLANNING',
  'EMERGENCY_FUND', 'INCOME_GROWTH',
];

// Map lens -> category for automatic assignment
const LENS_CATEGORY_MAP = {
  SPENDING_VELOCITY: 'SPENDING',
  CATEGORY_CONCENTRATION: 'SPENDING',
  UNUSUAL_SPENDING: 'SPENDING',
  INCOME_STABILITY: 'INCOME',
  INCOME_DIVERSIFICATION: 'INCOME',
  SAVINGS_RATE: 'SAVINGS',
  SAVINGS_TREND: 'SAVINGS',
  PORTFOLIO_EXPOSURE: 'PORTFOLIO',
  SECTOR_CONCENTRATION: 'PORTFOLIO',
  VALUATION_RISK: 'PORTFOLIO',
  DIVIDEND_OPPORTUNITY: 'PORTFOLIO',
  DEBT_HEALTH: 'DEBT',
  DEBT_PAYOFF_TRAJECTORY: 'DEBT',
  NET_WORTH_TRAJECTORY: 'NET_WORTH',
  NET_WORTH_MILESTONES: 'NET_WORTH',
};

// Lenses available per tier
const TIER_LENSES = {
  MONTHLY: [
    'SPENDING_VELOCITY', 'CATEGORY_CONCENTRATION', 'UNUSUAL_SPENDING',
    'INCOME_STABILITY', 'SAVINGS_RATE',
    'DEBT_HEALTH', 'NET_WORTH_TRAJECTORY', 'NET_WORTH_MILESTONES',
  ],
  QUARTERLY: [
    'SPENDING_VELOCITY', 'CATEGORY_CONCENTRATION',
    'INCOME_STABILITY', 'INCOME_DIVERSIFICATION',
    'SAVINGS_RATE', 'SAVINGS_TREND',
    'DEBT_HEALTH', 'DEBT_PAYOFF_TRAJECTORY',
    'NET_WORTH_TRAJECTORY', 'NET_WORTH_MILESTONES',
  ],
  ANNUAL: [
    'SPENDING_VELOCITY', 'CATEGORY_CONCENTRATION',
    'INCOME_STABILITY', 'INCOME_DIVERSIFICATION',
    'SAVINGS_RATE', 'SAVINGS_TREND',
    'DEBT_HEALTH', 'DEBT_PAYOFF_TRAJECTORY',
    'NET_WORTH_TRAJECTORY', 'NET_WORTH_MILESTONES',
  ],
  PORTFOLIO: [
    'PORTFOLIO_EXPOSURE', 'SECTOR_CONCENTRATION',
    'VALUATION_RISK', 'DIVIDEND_OPPORTUNITY',
  ],
};

// TTL per tier
const TIER_TTL_DAYS = {
  MONTHLY: 730,      // ~2 years
  QUARTERLY: 1825,   // ~5 years
  ANNUAL: null,       // forever
  PORTFOLIO: 365,     // 1 year
};

// ─── Currency Helpers ─────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', BRL: 'R$', JPY: '¥', CNY: '¥',
  AUD: 'A$', CAD: 'C$', CHF: 'CHF', INR: '₹', KRW: '₩', MXN: 'MX$',
};

/**
 * Resolve a currency rate from the job-local cache. Pure function — never
 * queries the DB, never calls external APIs. The cache must have been
 * populated up front by prefetchRatesForTier() before this is called.
 *
 * On an exact miss, scans the cache for the most recent prior rate for the
 * same currency pair (handles weekends, holidays, and other gaps in the
 * CurrencyRate table — standard financial practice). Returns null on a
 * true miss; callers are responsible for degrading gracefully.
 */
function lookupCurrencyRate(dateObj, currencyFrom, currencyTo, rateCache) {
  if (!currencyFrom || currencyFrom === currencyTo) return 1;

  const dateStr = dateObj.toISOString().slice(0, 10);
  const exactKey = `${dateStr}_${currencyFrom}_${currencyTo}`;
  if (rateCache[exactKey] != null) return Number(rateCache[exactKey]);

  // Nearest-prior scan: find the most recent cached rate for this pair
  // whose date is on or before the requested date.
  const suffix = `_${currencyFrom}_${currencyTo}`;
  let bestDate = null;
  let bestRate = null;
  for (const key of Object.keys(rateCache)) {
    if (!key.endsWith(suffix)) continue;
    const d = key.slice(0, 10);
    if (d <= dateStr && (bestDate === null || d > bestDate) && rateCache[key] != null) {
      bestDate = d;
      bestRate = rateCache[key];
    }
  }
  return bestRate != null ? Number(bestRate) : null;
}

/**
 * Synchronous currency conversion. Expects the rate cache to have been
 * populated by prefetchRatesForTier. On a true cache miss returns the
 * unconverted amount — same graceful fallback as the pre-v2 implementation.
 */
function convertAmount(amount, fromCurrency, toCurrency, date, rateCache) {
  if (!fromCurrency || fromCurrency === toCurrency || amount === 0) return amount;
  const rate = lookupCurrencyRate(date, fromCurrency, toCurrency, rateCache);
  if (rate == null) return amount;
  return rate * amount;
}

/**
 * Pre-fetch every currency rate a tier run will need, in a bounded number
 * of bulk range queries. After this returns, convertAmount() is guaranteed
 * to be an in-memory cache lookup with zero DB roundtrips and zero external
 * API calls for the remainder of the tier run.
 *
 * Pairs are derived from the tenant's distinct portfolio-item currencies
 * plus USD (for PortfolioValueHistory.valueInUSD). A 30-day floor is
 * applied to the fetch window so short-window tiers (PORTFOLIO reads
 * current state only) still have weekend/holiday fallback candidates in
 * the cache for lookupCurrencyRate's nearest-prior scan.
 */
async function prefetchRatesForTier({ tenantId, portfolioCurrency, startDate, endDate, rateCache }) {
  // Discover distinct currencies used by the tenant's portfolio items.
  // `PortfolioItem.currency` is declared `String` (non-nullable) in the
  // Prisma schema, so `{ not: null }` would be rejected by Prisma's
  // validator — and every row has a value by construction, so the filter
  // is redundant anyway.
  const positions = await prisma.portfolioItem.findMany({
    where: { tenantId },
    select: { currency: true },
    distinct: ['currency'],
  });

  const pairs = new Set();
  // PortfolioValueHistory stores valueInUSD, so we always need USD -> portfolioCurrency
  // unless the tenant already reports in USD.
  if (portfolioCurrency !== 'USD') {
    pairs.add(`USD|${portfolioCurrency}`);
  }
  for (const p of positions) {
    if (p.currency && p.currency !== portfolioCurrency) {
      pairs.add(`${p.currency}|${portfolioCurrency}`);
    }
  }

  if (pairs.size === 0) {
    logger.info('Insights rate prefetch: no conversion needed', { tenantId, portfolioCurrency });
    return;
  }

  // Apply a 30-day floor on the fetch window. This guarantees
  // lookupCurrencyRate's nearest-prior scan has candidates for weekend and
  // holiday dates even when the caller's window is very narrow (e.g.
  // PORTFOLIO tier passes today..today).
  const floorDate = new Date(endDate);
  floorDate.setUTCDate(floorDate.getUTCDate() - 30);
  const effectiveStart = startDate < floorDate ? startDate : floorDate;

  await Promise.all(
    [...pairs].map(async (pairKey) => {
      const [from, to] = pairKey.split('|');
      const rates = await getRatesForDateRange(effectiveStart, endDate, from, to);
      for (const [dateStr, rate] of rates.entries()) {
        rateCache[`${dateStr}_${from}_${to}`] = rate;
      }
    }),
  );

  logger.info('Insights rate prefetch complete', {
    tenantId,
    portfolioCurrency,
    pairs: [...pairs],
    window: {
      startDate: effectiveStart.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
    },
    cachedEntries: Object.keys(rateCache).length,
  });
}

// ─── Data Gathering Functions ────────────────────────────────────────────────

/**
 * Fetch tenant's portfolio currency and build a rate cache.
 */
async function getTenantContext(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { portfolioCurrency: true },
  });
  return {
    portfolioCurrency: tenant?.portfolioCurrency || 'USD',
    rateCache: {},
  };
}

/**
 * Fetch analytics data for a range of months.
 * Returns { monthlyData, sortedMonths } with income/expenses/groups per month key.
 */
async function gatherAnalyticsData(tenantId, months, portfolioCurrency) {
  const analyticsData = await prisma.analyticsCacheMonthly.findMany({
    where: {
      tenantId,
      currency: portfolioCurrency,
      OR: months.map(({ year, month }) => ({ year, month })),
    },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });

  // IMPORTANT — sign convention.
  //
  // Each AnalyticsCacheMonthly row stores a signed `balance = credit - debit`.
  // For Income rows balance is positive in the typical case (deposits) but
  // can be negative for clawbacks/reversals. For Essentials/Lifestyle/Growth
  // rows balance is negative in the typical case (purchases) but can be
  // positive when refunds exceed purchases for the period.
  //
  // The Financial Summary page (apps/web/src/lib/financial-summary.ts)
  // computes `netSavings = sum_signed(Income + Essentials + Lifestyle +
  // Growth)` and `savingsPercentage = netSavings / netIncome`, where each
  // type total is the sum of its rows' SIGNED balances. A refund in
  // Lifestyle correctly reduces total Lifestyle spend rather than adding to
  // it.
  //
  // A previous version of this aggregator used `Math.abs(balance)` per row,
  // which silently inflated expenses during refund-heavy months and
  // inflated income during clawback months — causing the savings rate to
  // drift away from what users see on the Financial Summary page. We mirror
  // FS's signed math here so the two surfaces always agree.
  const monthlyData = {};
  for (const entry of analyticsData) {
    const key = `${entry.year}-${String(entry.month).padStart(2, '0')}`;
    if (!monthlyData[key]) monthlyData[key] = { income: 0, expenses: 0, groups: {} };
    const signedBalance = Number(entry.balance || 0);

    if (entry.type === 'Income') {
      // Income balance is signed positive in the normal case; preserve sign
      // so a clawback row reduces income totals.
      monthlyData[key].income += signedBalance;
    } else if (['Essentials', 'Lifestyle', 'Growth'].includes(entry.type)) {
      // Expense balance is signed negative in the normal case. Negate to
      // accumulate expenses as a positive magnitude — but a refund-positive
      // row contributes a negative amount, correctly reducing total expense.
      const expenseMagnitude = -signedBalance;
      monthlyData[key].expenses += expenseMagnitude;
      const group = entry.group || 'Other';
      monthlyData[key].groups[group] = (monthlyData[key].groups[group] || 0) + expenseMagnitude;
    }
  }

  return {
    monthlyData,
    sortedMonths: Object.keys(monthlyData).sort(),
    hasTransactions: analyticsData.length > 0,
  };
}

/**
 * Compute spending velocity: month-over-month % change by group.
 */
function computeSpendingVelocity(monthlyData, sortedMonths, windowSize = 3) {
  const window = sortedMonths.slice(-windowSize);
  const velocity = {};
  if (window.length >= 2) {
    const prev = monthlyData[window[window.length - 2]];
    const curr = monthlyData[window[window.length - 1]];
    if (prev && curr) {
      const allGroups = new Set([...Object.keys(prev.groups || {}), ...Object.keys(curr.groups || {})]);
      for (const group of allGroups) {
        const prevAmt = prev.groups?.[group] || 0;
        const currAmt = curr.groups?.[group] || 0;
        if (prevAmt > 0) {
          velocity[group] = {
            previous: Math.round(prevAmt * 100) / 100,
            current: Math.round(currAmt * 100) / 100,
            changePercent: Math.round(((currAmt - prevAmt) / prevAmt) * 10000) / 100,
          };
        }
      }
    }
  }
  return velocity;
}

/**
 * Compute category concentration for a specific month.
 */
function computeCategoryConcentration(monthlyData, monthKey) {
  const data = monthlyData[monthKey] || { expenses: 0, groups: {} };
  const concentration = {};
  if (data.expenses > 0) {
    for (const [group, amount] of Object.entries(data.groups)) {
      concentration[group] = {
        amount: Math.round(amount * 100) / 100,
        percent: Math.round((amount / data.expenses) * 10000) / 100,
      };
    }
  }
  return concentration;
}

/**
 * Compute income and savings history from monthly data.
 */
function computeIncomeAndSavings(monthlyData, sortedMonths) {
  const incomeHistory = sortedMonths.map((m) => ({
    month: m,
    income: Math.round((monthlyData[m]?.income || 0) * 100) / 100,
  }));

  const savingsHistory = sortedMonths.map((m) => {
    const d = monthlyData[m] || { income: 0, expenses: 0 };
    const rate = d.income > 0 ? ((d.income - d.expenses) / d.income) * 100 : 0;
    return { month: m, rate: Math.round(rate * 100) / 100 };
  });

  return { incomeHistory, savingsHistory };
}

/**
 * Gather portfolio exposure and debt data.
 */
async function gatherPortfolioData(tenantId, portfolioCurrency, rateCache) {
  // Cash holdings (`processingHint: 'CASH'`) are deliberately excluded from
  // the insights pipeline. The portfolio page filters them out of the
  // user-visible net worth (apps/web/src/pages/reports/portfolio.tsx —
  // `group !== "Cash"`), so the LLM should reason over the same shape:
  // investments + tangible assets + debts, no cash drift.
  const portfolioItems = await prisma.portfolioItem.findMany({
    where: { tenantId, category: { processingHint: { not: 'CASH' } } },
    include: {
      category: { select: { name: true, group: true, type: true } },
      debtTerms: true,
    },
  });

  // Rate cache is populated up front by prefetchRatesForTier(). All
  // convertAmount() calls below are pure in-memory lookups — no DB, no
  // external API, no side effects.
  const today = new Date();

  // Portfolio exposure
  const investments = portfolioItems.filter((p) => p.category?.type === 'Investments');
  const investmentValues = investments.map((p) => {
    const rawValue = Math.abs(Number(p.currentValue || 0));
    const converted = convertAmount(rawValue, p.currency, portfolioCurrency, today, rateCache);
    return { item: p, value: converted };
  });
  const totalInvestmentValue = investmentValues.reduce((sum, iv) => sum + iv.value, 0);
  // `PortfolioItem` has no `name` column — `symbol` is the canonical
  // identifier. Historically this mapping read `iv.item.name` which silently
  // resolved to `undefined` and shipped `null` to the LLM prompt. See the
  // same pattern fixed in `gatherEquityFundamentals`.
  const portfolioExposure = investmentValues.map((iv) => ({
    name: iv.item.symbol,
    symbol: iv.item.symbol,
    value: Math.round(iv.value * 100) / 100,
    percent: totalInvestmentValue > 0
      ? Math.round((iv.value / totalInvestmentValue) * 10000) / 100
      : 0,
  }));

  // Debt health
  const debts = portfolioItems.filter((p) => p.category?.type === 'Debt');
  const debtHealth = debts.map((p) => {
    const rawBalance = Math.abs(Number(p.currentValue || 0));
    const convertedBalance = convertAmount(rawBalance, p.currency, portfolioCurrency, today, rateCache);
    const rawMinPayment = p.debtTerms?.minimumPayment ? Number(p.debtTerms.minimumPayment) : null;
    const convertedMinPayment = rawMinPayment !== null
      ? convertAmount(rawMinPayment, p.currency, portfolioCurrency, today, rateCache)
      : null;
    return {
      // `PortfolioItem.name` doesn't exist — use `symbol` (the user's chosen
      // identifier for manual debts, e.g. "mortgage-girassol-52").
      name: p.symbol,
      balance: Math.round(convertedBalance * 100) / 100,
      interestRate: p.debtTerms?.interestRate ? Number(p.debtTerms.interestRate) : null,
      minimumPayment: convertedMinPayment !== null ? Math.round(convertedMinPayment * 100) / 100 : null,
      termInMonths: p.debtTerms?.termInMonths ? Number(p.debtTerms.termInMonths) : null,
      originationDate: p.debtTerms?.originationDate || null,
    };
  });

  return {
    portfolioExposure,
    debtHealth,
    totalInvestmentValue: Math.round(totalInvestmentValue * 100) / 100,
    totalDebt: debtHealth.reduce((sum, d) => sum + d.balance, 0),
    hasPortfolio: portfolioItems.length > 0,
    hasDebt: debts.length > 0,
  };
}

/**
 * Gather net worth history for a date range.
 *
 * `PortfolioValueHistory` stores one row per asset per day, so a naive
 * `findMany()` over a 15-month quarterly window for a tenant with ~50
 * assets ships ~22k rows × 9 decimal columns back from Prisma — blowing
 * through Prisma Accelerate's 5MB response limit (P6009) and, more
 * importantly, returning duplicate date entries that were never really
 * "net worth". Aggregating server-side via `groupBy({ by: ['date'] })`
 * collapses each day to a single sum across all assets and ships only
 * two values per row (date + `_sum.valueInUSD`).
 */
async function gatherNetWorthHistory(tenantId, startDate, portfolioCurrency, rateCache, endDate = null) {
  // `endDate` caps the upper bound at the target period's end. Without it,
  // regenerating insights for a past period (e.g., MONTHLY for March 2026
  // generated on April 27) would include net-worth entries from after the
  // period being analyzed, and consumers (KEY SIGNALS' netWorthDecomposition)
  // would surface the most recent value as "end of March" — wildly wrong if
  // the portfolio moved meaningfully in the intervening weeks.
  //
  // SAMPLING: we pull only the LAST CALENDAR DAY of each month in the
  // window. This mirrors the portfolio history table at `monthly`
  // resolution (apps/api/pages/api/portfolio/history.js, buildSampleDates)
  // so the values the LLM sees and reasons about match what the user sees
  // on the portfolio page. Sending every daily entry would leave the LLM
  // free to pick "Feb 5" as "Feb-end" — what users actually see is the
  // Feb-28 value, so that's what we send.
  const cap = endDate || new Date();
  const monthEnds = [];
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  while (cursor <= cap) {
    const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    if (lastDay >= startDate && lastDay <= cap) monthEnds.push(lastDay);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  // If the period ends mid-month (rare for insight runs since we cap at
  // end-of-month already, but possible for ad-hoc callers), include the
  // cap itself as the trailing data point.
  const capStr = cap.toISOString().split('T')[0];
  if (!monthEnds.some((d) => d.toISOString().split('T')[0] === capStr)) {
    monthEnds.push(cap);
  }

  if (monthEnds.length === 0) return [];

  // Cash holdings are excluded from net worth in the insights pipeline —
  // see gatherPortfolioData for the rationale. This filter mirrors what
  // the portfolio page does on the client.
  const aggregated = await prisma.portfolioValueHistory.groupBy({
    by: ['date'],
    where: {
      asset: { tenantId, category: { processingHint: { not: 'CASH' } } },
      date: { in: monthEnds },
    },
    _sum: { valueInUSD: true },
    orderBy: { date: 'asc' },
  });

  // Rate cache is populated up front by prefetchRatesForTier() with the
  // USD -> portfolioCurrency pair covering the full net-worth window.
  // convertAmount() below is a pure in-memory lookup.
  return aggregated.map((row) => {
    const usdValue = Number(row._sum?.valueInUSD || 0);
    const convertedValue = convertAmount(usdValue, 'USD', portfolioCurrency, row.date, rateCache);
    return {
      date: row.date.toISOString().slice(0, 10),
      value: Math.round(convertedValue * 100) / 100,
    };
  });
}

/**
 * Decompose net-worth change between the start and end of a TARGET PERIOD
 * (not the full trend window) into per-CATEGORY-GROUP buckets — Real
 * Estate, Stock, ETF, Crypto, Mortgage… — so the LLM can attribute
 * appreciation correctly.
 *
 * IMPORTANT — anchor semantics. The caller passes the period boundaries
 * directly:
 *   MONTHLY March 2026  → periodStart = Feb 28 2026, periodEnd = Mar 31 2026
 *   QUARTERLY Q1 2026   → periodStart = Dec 31 2025, periodEnd = Mar 31 2026
 *   ANNUAL 2026         → periodStart = Dec 31 2025, periodEnd = Dec 31 2026
 *
 * A previous version used the full trend window (sixMonthsAgo /
 * twelveMonthsAgo / threeYearsAgo) as the start anchor, which silently
 * inflated quarterly/monthly buckets by attributing 14 months of change
 * to a "Q1" insight. Always pass the period boundaries.
 *
 * Returns `[{ group, type, start, end, change, changePct }]` sorted by
 * absolute change. Empty when either anchor has no snapshot rows.
 */
async function gatherNetWorthBreakdown(tenantId, periodStart, periodEnd, portfolioCurrency, rateCache) {
  if (!(periodStart instanceof Date) || !(periodEnd instanceof Date)) return [];
  if (periodStart >= periodEnd) return [];

  // Cash holdings excluded — see gatherPortfolioData for the rationale.
  const rows = await prisma.portfolioValueHistory.groupBy({
    by: ['date', 'assetId'],
    where: {
      asset: { tenantId, category: { processingHint: { not: 'CASH' } } },
      date: { in: [periodStart, periodEnd] },
    },
    _sum: { valueInUSD: true },
  });

  if (!rows.length) return [];

  const assetIds = [...new Set(rows.map((r) => r.assetId))];
  const assets = await prisma.portfolioItem.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, category: { select: { type: true, group: true } } },
  });
  const categoryByAssetId = new Map(
    assets.map((a) => [
      a.id,
      { type: a.category?.type || 'Other', group: a.category?.group || 'Other' },
    ]),
  );

  const startStr = periodStart.toISOString().split('T')[0];
  const endStr = periodEnd.toISOString().split('T')[0];

  // Aggregate by (group, type) — the (group, type) pair lets us keep
  // distinct buckets if a tenant happens to have, say, "Real Estate"
  // both under Investments and under Asset. Each bucket is summed in
  // portfolioCurrency at the snapshot's own date so cross-currency
  // changes don't get smeared by today's FX rate.
  const totals = new Map(); // key: `${group}|${type}` → { group, type, start, end }
  for (const r of rows) {
    const cat = categoryByAssetId.get(r.assetId) || { type: 'Other', group: 'Other' };
    const key = `${cat.group}|${cat.type}`;
    const usd = Number(r._sum?.valueInUSD || 0);
    const dateStr = r.date.toISOString().split('T')[0];
    const converted = convertAmount(usd, 'USD', portfolioCurrency, r.date, rateCache);
    if (!totals.has(key)) totals.set(key, { group: cat.group, type: cat.type, start: 0, end: 0 });
    const bucket = totals.get(key);
    if (dateStr === startStr) bucket.start += converted;
    else if (dateStr === endStr) bucket.end += converted;
  }

  const breakdown = [...totals.values()].map(({ group, type, start, end }) => ({
    group,
    type,
    start: Math.round(start * 100) / 100,
    end: Math.round(end * 100) / 100,
    change: Math.round((end - start) * 100) / 100,
    changePct: start !== 0 ? Math.round(((end - start) / Math.abs(start)) * 1000) / 10 : null,
  }));

  // Sort by absolute change (largest mover first) so the LLM sees what
  // matters at the top of the list.
  breakdown.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return breakdown;
}

/**
 * Gather SecurityMaster fundamentals for portfolio holdings.
 * Used by PORTFOLIO tier.
 *
 * NOTE: `PortfolioItem` has no `ticker` column — the ticker symbol is
 * stored in the `symbol` field (which is non-nullable). Historically this
 * function referenced a phantom `ticker` field that silently fell back to
 * `symbol` at runtime; under strict Prisma validation the filter now
 * crashes. Keep everything on `symbol`.
 *
 * CURRENCY: every monetary value returned by this function is expressed
 * in `portfolioCurrency`. The tenant may hold assets in multiple native
 * currencies (e.g. a Brazilian investor holding VALE3 in BRL and AAPL in
 * USD while reporting in BRL). Historically this function shipped raw
 * `PortfolioItem.currentValue` / `costBasis` / `realizedPnL` to the prompt
 * without conversion, so Gemini saw mixed-currency numbers it couldn't
 * reconcile — a R$1M holding was described as "a $1 million position".
 * We now convert each holding's monetary fields through the shared
 * `rateCache` (populated by `prefetchRatesForTier`) before building the
 * sector allocation, total value, and returned holdings array.
 */
async function gatherEquityFundamentals(tenantId, portfolioCurrency, rateCache) {
  // `PortfolioItem` has no `name` column — only `symbol`, `isin`, `exchange`.
  // The human-readable asset name comes from the joined `SecurityMaster.name`
  // (e.g. "Apple Inc"), which is already selected below. For holdings without
  // a SecurityMaster row we fall back to the symbol.
  const holdings = await prisma.portfolioItem.findMany({
    where: {
      tenantId,
      quantity: { gt: 0 },
      category: { type: 'Investments' },
    },
    select: {
      id: true,
      symbol: true,
      currency: true,
      currentValue: true,
      costBasis: true,
      quantity: true,
      realizedPnL: true,
      category: { select: { name: true, processingHint: true } },
    },
  });

  const symbols = holdings.map((h) => h.symbol).filter(Boolean);
  if (symbols.length === 0) return { holdings: [], sectorAllocation: {}, industryAllocation: {}, totalValue: 0 };

  const fundamentals = await prisma.securityMaster.findMany({
    where: { symbol: { in: symbols } },
    select: {
      symbol: true,
      name: true,
      sector: true,
      industry: true,
      country: true,
      peRatio: true,
      dividendYield: true,
      trailingEps: true,
      latestEpsActual: true,
      latestEpsSurprise: true,
      week52High: true,
      week52Low: true,
      averageVolume: true,
      assetType: true,
      // Trust flags decide whether earnings- and dividend-derived fields
      // can be passed to the LLM. When false, those fields are nulled out
      // below — wrong data is worse than missing data for portfolio insights.
      earningsTrusted: true,
      dividendTrusted: true,
    },
  });

  // Merge holdings with fundamentals + convert every monetary field to the
  // tenant's portfolio currency. The rate cache is expected to have been
  // populated up front by prefetchRatesForTier, so each convertAmount() is
  // a pure in-memory lookup (nearest-prior fallback for weekends/holidays).
  //
  // Per-security quote fields (peRatio, dividendYield, week52High/Low,
  // trailingEps) are intentionally *not* converted: those are fundamentals
  // from SecurityMaster that are already quoted in the security's listing
  // currency and don't get rolled up into tenant-level totals. We pass them
  // through as-is for context, tagged with the holding's native currency.
  const fundamentalsMap = new Map(fundamentals.map((f) => [f.symbol, f]));
  const today = new Date();
  // Derive a human-readable sector label from the category when SecurityMaster
  // has no data (e.g. ETFs, funds, crypto, manual assets). This prevents the
  // LLM from lumping everything without fundamentals into a single "Unknown"
  // bucket and flagging it as a concentration risk.
  const HINT_TO_SECTOR = {
    API_FUND: 'ETFs & Funds',
    API_CRYPTO: 'Cryptocurrency',
    MANUAL: 'Alternative Assets',
  };
  const enrichedHoldings = holdings.map((h) => {
    const f = fundamentalsMap.get(h.symbol) || {};
    const nativeCurrency = h.currency || portfolioCurrency;
    const rawCurrentValue = Number(h.currentValue || 0);
    const rawCostBasis = Number(h.costBasis || 0);
    const rawRealizedPnL = Number(h.realizedPnL || 0);
    const convertedCurrentValue = convertAmount(rawCurrentValue, nativeCurrency, portfolioCurrency, today, rateCache);
    const convertedCostBasis = convertAmount(rawCostBasis, nativeCurrency, portfolioCurrency, today, rateCache);
    const convertedRealizedPnL = convertAmount(rawRealizedPnL, nativeCurrency, portfolioCurrency, today, rateCache);
    const fallbackSector = HINT_TO_SECTOR[h.category?.processingHint] || h.category?.name || 'Other';
    return {
      symbol: h.symbol,
      name: f.name || h.symbol,
      nativeCurrency,
      currentValue: Math.round(convertedCurrentValue * 100) / 100,
      costBasis: Math.round(convertedCostBasis * 100) / 100,
      quantity: Number(h.quantity || 0),
      unrealizedPnL: Math.round((convertedCurrentValue - convertedCostBasis) * 100) / 100,
      realizedPnL: Math.round(convertedRealizedPnL * 100) / 100,
      sector: f.sector || fallbackSector,
      industry: f.industry || fallbackSector,
      country: f.country || 'Global',
      // Earnings-derived fields are gated on earningsTrusted: when Twelve Data
      // returned inconsistent data (off-by-one timezone, sparse history, stale
      // last quarter), the upsert flagged the row untrusted. Hide those fields
      // from the LLM rather than feed it numbers we know to be wrong.
      peRatio: f.earningsTrusted && f.peRatio ? Number(f.peRatio) : null,
      trailingEps: f.earningsTrusted && f.trailingEps ? Number(f.trailingEps) : null,
      dividendYield: f.dividendTrusted && f.dividendYield ? Number(f.dividendYield) : null,
      week52High: f.week52High ? Number(f.week52High) : null,
      week52Low: f.week52Low ? Number(f.week52Low) : null,
      assetType: f.assetType || fallbackSector,
    };
  });

  // Compute sector + industry allocation using the already-converted values.
  // Industry-level breakdown lets the LLM go one layer deeper than "Technology
  // is 47%" — e.g. "Semiconductors carry 28% of the equity book inside that."
  // Industry rows carry their parent sector so the prompt can group them.
  const totalValue = enrichedHoldings.reduce((sum, h) => sum + Math.abs(h.currentValue), 0);
  const sectorAllocation = {};
  const industryAllocation = {};
  for (const h of enrichedHoldings) {
    const sector = h.sector || 'Unknown';
    if (!sectorAllocation[sector]) sectorAllocation[sector] = { value: 0, count: 0, holdings: [] };
    sectorAllocation[sector].value += Math.abs(h.currentValue);
    sectorAllocation[sector].count++;
    sectorAllocation[sector].holdings.push(h.symbol);

    const industry = h.industry || sector;
    if (!industryAllocation[industry]) industryAllocation[industry] = { value: 0, count: 0, sector, holdings: [] };
    industryAllocation[industry].value += Math.abs(h.currentValue);
    industryAllocation[industry].count++;
    industryAllocation[industry].holdings.push(h.symbol);
  }
  for (const sector of Object.keys(sectorAllocation)) {
    sectorAllocation[sector].value = Math.round(sectorAllocation[sector].value * 100) / 100;
    sectorAllocation[sector].percent = totalValue > 0
      ? Math.round((sectorAllocation[sector].value / totalValue) * 10000) / 100
      : 0;
  }
  for (const industry of Object.keys(industryAllocation)) {
    industryAllocation[industry].value = Math.round(industryAllocation[industry].value * 100) / 100;
    industryAllocation[industry].percent = totalValue > 0
      ? Math.round((industryAllocation[industry].value / totalValue) * 10000) / 100
      : 0;
  }

  return {
    holdings: enrichedHoldings,
    sectorAllocation,
    industryAllocation,
    totalValue: Math.round(totalValue * 100) / 100,
  };
}

// ─── Tier-Specific Data Gathering ────────────────────────────────────────────

/**
 * Gather data for Monthly Review tier.
 * Full month data with comparisons to prior month and same month last year.
 */
async function gatherMonthlyData(tenantId, year, month, comparisonAvailable) {
  const ctx = await getTenantContext(tenantId);

  // Prefetch all currency rates this tier run will need up front. After
  // this, every convertAmount() call is an in-memory cache lookup with
  // zero DB roundtrips and zero external API calls.
  const sixMonthsAgo = new Date(year, month - 7, 1);
  // End of the target month (last second of the last day). Caps both the
  // currency-rate prefetch and the netWorthHistory window so a
  // re-generation of an old period is not contaminated by data from after
  // that period closed.
  const endOfTargetMonth = new Date(year, month, 0, 23, 59, 59, 999);
  await prefetchRatesForTier({
    tenantId,
    portfolioCurrency: ctx.portfolioCurrency,
    startDate: sixMonthsAgo,
    endDate: endOfTargetMonth,
    rateCache: ctx.rateCache,
  });

  // Build month list: target month + prior month + same month last year + 2 months before for velocity
  const monthList = [
    { year, month },
  ];

  // Prior 3 months for velocity context
  for (let i = 1; i <= 3; i++) {
    let m = month - i;
    let y = year;
    if (m <= 0) { m += 12; y -= 1; }
    monthList.push({ year: y, month: m });
  }

  // Same month last year
  monthList.push({ year: year - 1, month });

  const analytics = await gatherAnalyticsData(tenantId, monthList, ctx.portfolioCurrency);
  const spendingVelocity = computeSpendingVelocity(analytics.monthlyData, analytics.sortedMonths, 4);

  const targetKey = `${year}-${String(month).padStart(2, '0')}`;
  const categoryConcentration = computeCategoryConcentration(analytics.monthlyData, targetKey);
  const { incomeHistory, savingsHistory } = computeIncomeAndSavings(analytics.monthlyData, analytics.sortedMonths);

  // Portfolio + debt
  const portfolio = await gatherPortfolioData(tenantId, ctx.portfolioCurrency, ctx.rateCache);

  // Net worth (6 months back, capped at end of the target month — see
  // gatherNetWorthHistory's `endDate` param for why this cap matters).
  const netWorthHistory = await gatherNetWorthHistory(tenantId, sixMonthsAgo, ctx.portfolioCurrency, ctx.rateCache, endOfTargetMonth);
  // Net-worth breakdown is anchored to the TARGET PERIOD boundaries
  // (prior-month-end → target-month-end), NOT the trend-window start. See
  // gatherNetWorthBreakdown's docstring.
  const priorMonthEndUTC = new Date(Date.UTC(year, month - 1, 0));
  const targetMonthEndUTC = new Date(Date.UTC(year, month, 0));
  const netWorthBreakdown = await gatherNetWorthBreakdown(tenantId, priorMonthEndUTC, targetMonthEndUTC, ctx.portfolioCurrency, ctx.rateCache);

  // Same month last year data for comparison
  const yoyKey = `${year - 1}-${String(month).padStart(2, '0')}`;
  const yoyData = analytics.monthlyData[yoyKey] || null;

  return {
    tier: 'MONTHLY',
    portfolioCurrency: ctx.portfolioCurrency,
    targetPeriod: targetKey,
    months: analytics.sortedMonths,
    monthlyData: analytics.monthlyData,
    spendingVelocity,
    categoryConcentration,
    incomeHistory,
    savingsHistory,
    ...portfolio,
    netWorthHistory,
    netWorthBreakdown,
    hasTransactions: analytics.hasTransactions,
    comparisonAvailable,
    yearOverYear: yoyData ? {
      month: yoyKey,
      income: Math.round((yoyData.income || 0) * 100) / 100,
      expenses: Math.round((yoyData.expenses || 0) * 100) / 100,
    } : null,
  };
}

/**
 * Gather data for Quarterly Deep Dive tier.
 * Full quarter aggregated + prior quarter + same quarter YoY + rolling trends.
 */
async function gatherQuarterlyData(tenantId, year, quarter, comparisonAvailable) {
  const ctx = await getTenantContext(tenantId);

  // Prefetch rates up front — covers the full 12-month net-worth window
  // that gatherNetWorthHistory will read below. End is capped at the last
  // day of the target quarter so a re-generation of an old quarter doesn't
  // pull data from after that quarter closed.
  const firstTargetMonth = getQuarterMonths(quarter)[0];
  const lastTargetMonth = getQuarterMonths(quarter)[2];
  const twelveMonthsAgo = new Date(year, firstTargetMonth - 13, 1);
  const endOfTargetQuarter = new Date(year, lastTargetMonth, 0, 23, 59, 59, 999);
  await prefetchRatesForTier({
    tenantId,
    portfolioCurrency: ctx.portfolioCurrency,
    startDate: twelveMonthsAgo,
    endDate: endOfTargetQuarter,
    rateCache: ctx.rateCache,
  });

  // Build month list: target quarter + prior quarter + same quarter last year + 3 months before
  const targetMonths = getQuarterMonths(quarter);
  const monthList = targetMonths.map((m) => ({ year, month: m }));

  // Prior quarter
  let prevQ = quarter - 1;
  let prevQYear = year;
  if (prevQ <= 0) { prevQ = 4; prevQYear -= 1; }
  const prevMonths = getQuarterMonths(prevQ);
  for (const m of prevMonths) monthList.push({ year: prevQYear, month: m });

  // Same quarter last year
  for (const m of targetMonths) monthList.push({ year: year - 1, month: m });

  // 3 months before for extended context
  const firstMonth = targetMonths[0];
  for (let i = 1; i <= 3; i++) {
    let m = firstMonth - i;
    let y = year;
    if (m <= 0) { m += 12; y -= 1; }
    monthList.push({ year: y, month: m });
  }

  const analytics = await gatherAnalyticsData(tenantId, monthList, ctx.portfolioCurrency);
  const spendingVelocity = computeSpendingVelocity(analytics.monthlyData, analytics.sortedMonths, 6);

  // Aggregate quarter-level totals
  const quarterTotals = { income: 0, expenses: 0, groups: {} };
  for (const m of targetMonths) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const d = analytics.monthlyData[key];
    if (d) {
      quarterTotals.income += d.income;
      quarterTotals.expenses += d.expenses;
      for (const [g, amt] of Object.entries(d.groups || {})) {
        quarterTotals.groups[g] = (quarterTotals.groups[g] || 0) + amt;
      }
    }
  }

  const { incomeHistory, savingsHistory } = computeIncomeAndSavings(analytics.monthlyData, analytics.sortedMonths);
  const portfolio = await gatherPortfolioData(tenantId, ctx.portfolioCurrency, ctx.rateCache);

  // Net worth (12 months back, capped at end of the target quarter).
  const netWorthHistory = await gatherNetWorthHistory(tenantId, twelveMonthsAgo, ctx.portfolioCurrency, ctx.rateCache, endOfTargetQuarter);
  // Breakdown anchors: prior-quarter-end → target-quarter-end.
  const priorQuarterEndUTC = new Date(Date.UTC(year, firstTargetMonth - 1, 0));
  const targetQuarterEndUTC = new Date(Date.UTC(year, lastTargetMonth, 0));
  const netWorthBreakdown = await gatherNetWorthBreakdown(tenantId, priorQuarterEndUTC, targetQuarterEndUTC, ctx.portfolioCurrency, ctx.rateCache);

  return {
    tier: 'QUARTERLY',
    portfolioCurrency: ctx.portfolioCurrency,
    targetPeriod: `${year}-Q${quarter}`,
    quarterTotals,
    months: analytics.sortedMonths,
    monthlyData: analytics.monthlyData,
    spendingVelocity,
    incomeHistory,
    savingsHistory,
    ...portfolio,
    netWorthHistory,
    netWorthBreakdown,
    hasTransactions: analytics.hasTransactions,
    comparisonAvailable,
  };
}

/**
 * Gather data for Annual Report tier.
 * Full year aggregated by month + 1-2 prior years for trends.
 */
async function gatherAnnualData(tenantId, year, comparisonAvailable) {
  const ctx = await getTenantContext(tenantId);

  // Prefetch rates up front — covers the full 3-year net-worth window
  // that gatherNetWorthHistory reads below, plus all intermediate months.
  // End is capped at the last day of the target year so a re-generation of
  // an old annual report doesn't pull data from after that year closed.
  const threeYearsAgo = new Date(year - 2, 0, 1);
  const endOfTargetYear = new Date(year, 12, 0, 23, 59, 59, 999);
  await prefetchRatesForTier({
    tenantId,
    portfolioCurrency: ctx.portfolioCurrency,
    startDate: threeYearsAgo,
    endDate: endOfTargetYear,
    rateCache: ctx.rateCache,
  });

  // Build month list: target year + 2 prior years
  const monthList = [];
  for (let y = year - 2; y <= year; y++) {
    for (let m = 1; m <= 12; m++) {
      monthList.push({ year: y, month: m });
    }
  }

  const analytics = await gatherAnalyticsData(tenantId, monthList, ctx.portfolioCurrency);

  // Aggregate year-level totals for each year
  const yearlyTotals = {};
  for (let y = year - 2; y <= year; y++) {
    yearlyTotals[y] = { income: 0, expenses: 0, groups: {}, months: {} };
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const d = analytics.monthlyData[key];
      if (d) {
        yearlyTotals[y].income += d.income;
        yearlyTotals[y].expenses += d.expenses;
        yearlyTotals[y].months[key] = d;
        for (const [g, amt] of Object.entries(d.groups || {})) {
          yearlyTotals[y].groups[g] = (yearlyTotals[y].groups[g] || 0) + amt;
        }
      }
    }
    // Round
    yearlyTotals[y].income = Math.round(yearlyTotals[y].income * 100) / 100;
    yearlyTotals[y].expenses = Math.round(yearlyTotals[y].expenses * 100) / 100;
    yearlyTotals[y].savingsRate = yearlyTotals[y].income > 0
      ? Math.round(((yearlyTotals[y].income - yearlyTotals[y].expenses) / yearlyTotals[y].income) * 10000) / 100
      : 0;
  }

  const { incomeHistory, savingsHistory } = computeIncomeAndSavings(analytics.monthlyData, analytics.sortedMonths);
  const portfolio = await gatherPortfolioData(tenantId, ctx.portfolioCurrency, ctx.rateCache);

  // Net worth (3 years back, capped at end of the target year).
  const netWorthHistory = await gatherNetWorthHistory(tenantId, threeYearsAgo, ctx.portfolioCurrency, ctx.rateCache, endOfTargetYear);
  // Breakdown anchors: prior-year-end → target-year-end.
  const priorYearEndUTC = new Date(Date.UTC(year, 0, 0));
  const targetYearEndUTC = new Date(Date.UTC(year, 12, 0));
  const netWorthBreakdown = await gatherNetWorthBreakdown(tenantId, priorYearEndUTC, targetYearEndUTC, ctx.portfolioCurrency, ctx.rateCache);

  return {
    tier: 'ANNUAL',
    portfolioCurrency: ctx.portfolioCurrency,
    targetPeriod: `${year}`,
    yearlyTotals,
    months: analytics.sortedMonths,
    monthlyData: analytics.monthlyData,
    incomeHistory,
    savingsHistory,
    ...portfolio,
    netWorthHistory,
    netWorthBreakdown,
    hasTransactions: analytics.hasTransactions,
    comparisonAvailable,
  };
}

/**
 * Gather data for Portfolio Intelligence tier.
 * Current holdings + SecurityMaster fundamentals.
 */
/**
 * Sum the user's "Passive Income" category over the last N months from
 * AnalyticsCacheMonthly. Returns null when the user has no such category or
 * no rows yet — the caller should treat that as "skip this signal" rather
 * than "$0 reported."
 *
 * The DIVIDEND_OPPORTUNITY lens uses this to anchor on actual realised
 * income (rent, dividends, interest) instead of a projection from yields,
 * which is more credible to the user reading the insight.
 */
async function gatherPassiveIncomeRecent(tenantId, portfolioCurrency, monthsBack = 3) {
  const today = new Date();
  const months = [];
  for (let i = 0; i < monthsBack; i += 1) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  const rows = await prisma.analyticsCacheMonthly.findMany({
    where: {
      tenantId,
      currency: portfolioCurrency,
      type: 'Income',
      group: 'Passive Income',
      OR: months.map(({ year, month }) => ({ year, month })),
    },
    select: { year: true, month: true, balance: true },
  });

  if (rows.length === 0) return null;

  const total = rows.reduce((s, r) => s + Number(r.balance || 0), 0);
  return {
    monthsCovered: monthsBack,
    total: Math.round(total * 100) / 100,
    monthly: rows
      .map((r) => ({
        period: `${r.year}-${String(r.month).padStart(2, '0')}`,
        amount: Math.round(Number(r.balance || 0) * 100) / 100,
      }))
      .sort((a, b) => a.period.localeCompare(b.period)),
  };
}

async function gatherPortfolioIntelligenceData(tenantId) {
  const ctx = await getTenantContext(tenantId);

  // PORTFOLIO tier reads current state only, but gatherPortfolioData
  // still needs to convert each holding's currentValue into the
  // portfolio currency. Pre-fetch with today..today — the 30-day floor
  // inside prefetchRatesForTier expands the window so weekend/holiday
  // runs still have nearest-prior candidates in the cache.
  const now = new Date();
  await prefetchRatesForTier({
    tenantId,
    portfolioCurrency: ctx.portfolioCurrency,
    startDate: now,
    endDate: now,
    rateCache: ctx.rateCache,
  });

  const portfolio = await gatherPortfolioData(tenantId, ctx.portfolioCurrency, ctx.rateCache);
  const equityData = await gatherEquityFundamentals(tenantId, ctx.portfolioCurrency, ctx.rateCache);
  const passiveIncomeRecent = await gatherPassiveIncomeRecent(tenantId, ctx.portfolioCurrency, 3);

  return {
    tier: 'PORTFOLIO',
    portfolioCurrency: ctx.portfolioCurrency,
    ...portfolio,
    equityHoldings: equityData.holdings,
    sectorAllocation: equityData.sectorAllocation,
    industryAllocation: equityData.industryAllocation,
    totalEquityValue: equityData.totalValue,
    passiveIncomeRecent,
    hasPortfolio: portfolio.hasPortfolio,
  };
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────
//
// Prompt content (L1 identity, L2 tier, L3 lens rubrics, L4 few-shot
// examples) and pre-computed signals live in `services/insightPrompts/`.
// `buildTieredPrompt` is preserved as a thin compatibility shim for older
// tests; the live path uses the structured builder + adapter contract.

function buildTieredPrompt(tier, tenantData, activeLenses) {
  const systemBlocks = buildSystemBlocks(tier, activeLenses);
  const userMessage = buildUserMessage(tier, tenantData, activeLenses);
  return `${systemBlocks.map((b) => b.text).join('\n\n')}\n\n${userMessage}`;
}

// ─── Filter Active Lenses ────────────────────────────────────────────────────

function filterActiveLenses(tier, tenantData) {
  const tierLenses = TIER_LENSES[tier] || [];

  return tierLenses.filter((lens) => {
    switch (lens) {
      case 'PORTFOLIO_EXPOSURE':
      case 'SECTOR_CONCENTRATION':
      case 'VALUATION_RISK':
      case 'DIVIDEND_OPPORTUNITY':
        return (tenantData.portfolioExposure?.length > 0) ||
               (tenantData.equityHoldings?.length > 0);
      case 'DEBT_HEALTH':
      case 'DEBT_PAYOFF_TRAJECTORY':
        return tenantData.hasDebt || tenantData.debtHealth?.length > 0;
      case 'NET_WORTH_TRAJECTORY':
      case 'NET_WORTH_MILESTONES':
        return tenantData.netWorthHistory?.length > 0;
      default:
        return tenantData.hasTransactions;
    }
  });
}

// ─── TTL Computation ─────────────────────────────────────────────────────────

function computeExpiresAt(tier) {
  const ttlDays = TIER_TTL_DAYS[tier];
  if (!ttlDays) return null; // ANNUAL = forever
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + ttlDays);
  return expiresAt;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/**
 * Derive the correct period key for a tier + params bundle.
 *
 * The frontend's "Generate all tiers" flow and per-tier refresh both send
 * explicit `year`/`month`/`quarter` but not `periodKey`. The legacy fallback
 * of `getPeriodKey(tier, new Date())` silently used *today's* period, which
 * caused an ANNUAL report about 2025 to land under `2026`, a QUARTERLY Q1
 * to land under Q2, and a MONTHLY March report to land under April — see
 * the Insights v1.1 bug report. Deriving from the explicit year/month/quarter
 * first ensures the generated insights are always stored against the period
 * they actually describe.
 */
function derivePeriodKey(tier, params) {
  // The Insight.periodKey column is a String. Always coerce to String so
  // an upstream caller passing a number (e.g. an integer year for ANNUAL)
  // doesn't break the dedup query with a Prisma type validation error.
  if (params.periodKey != null && params.periodKey !== '') return String(params.periodKey);
  const { year, month, quarter } = params;
  if (tier === 'MONTHLY' && year && month) {
    return `${year}-${String(month).padStart(2, '0')}`;
  }
  if (tier === 'QUARTERLY' && year && quarter) {
    return `${year}-Q${quarter}`;
  }
  if (tier === 'ANNUAL' && year) {
    return `${year}`;
  }
  // PORTFOLIO (current-state tier) and any tier called with no period args:
  // the ISO-week / current-period derivation from `new Date()` is correct.
  return String(getPeriodKey(tier, new Date()));
}

/**
 * Generate insights for a specific tier.
 * This is the main entry point for the worker.
 */
async function generateTieredInsights(tenantId, tier, params = {}) {
  const { year, month, quarter, force } = params;
  logger.info('Starting tiered insight generation:', { tenantId, tier, params });

  // 1. Completeness check
  const completeness = await checkTierCompleteness(tenantId, tier, { year, month, quarter, force });
  if (!completeness.canRun) {
    logger.info('Skipping insight generation — completeness check failed:', {
      tenantId, tier, details: completeness.details,
    });
    return { skipped: true, reason: completeness.details?.reason || 'Insufficient data' };
  }

  // 2. Gather tier-specific data
  let tenantData;
  switch (tier) {
    case 'MONTHLY':
      tenantData = await gatherMonthlyData(tenantId, year, month, completeness.comparisonAvailable);
      break;
    case 'QUARTERLY':
      tenantData = await gatherQuarterlyData(tenantId, year, quarter, completeness.comparisonAvailable);
      break;
    case 'ANNUAL':
      tenantData = await gatherAnnualData(tenantId, year, completeness.comparisonAvailable);
      break;
    case 'PORTFOLIO':
      tenantData = await gatherPortfolioIntelligenceData(tenantId);
      break;
    default:
      throw new Error(`Unknown tier: ${tier}`);
  }

  // Check if we have any data at all
  if (!tenantData.hasTransactions && !tenantData.hasPortfolio && tier !== 'PORTFOLIO') {
    logger.info('Skipping insight generation — no data:', { tenantId, tier });
    return { skipped: true, reason: 'No transaction or portfolio data' };
  }
  if (tier === 'PORTFOLIO' && !tenantData.equityHoldings?.length) {
    logger.info('Skipping portfolio insights — no equity holdings:', { tenantId });
    return { skipped: true, reason: 'No equity holdings with fundamentals' };
  }

  // 3. Compute data hash for dedup
  const hashInput = JSON.stringify(tenantData);
  const dataHash = crypto.createHash('sha256').update(hashInput).digest('hex');
  // Derive from explicit params first — see derivePeriodKey JSDoc for why
  // falling back to `new Date()` was causing the "April 2026 → March 2026"
  // off-by-one reported by the v1.1 period-selector bug.
  const periodKey = derivePeriodKey(tier, params);

  // Check dedup: same tier + same period + same data = skip
  const existingInsight = await prisma.insight.findFirst({
    where: { tenantId, tier, periodKey, dataHash },
    select: { id: true, batchId: true },
  });

  if (existingInsight && !force) {
    logger.info('Data unchanged for this period, skipping generation:', {
      tenantId, tier, periodKey, dataHash: dataHash.slice(0, 12),
    });
    return { skipped: true, reason: 'Data unchanged since last batch for this period' };
  }

  // 4. Filter active lenses
  const activeLenses = filterActiveLenses(tier, tenantData);
  if (activeLenses.length === 0) {
    logger.info('No active lenses after filtering:', { tenantId, tier });
    return { skipped: true, reason: 'No active lenses' };
  }

  // 5. Build prompt and call LLM via the structured contract — system blocks
  //    (L1+L2+L3+L4, each cacheable) plus the user message (KEY SIGNALS +
  //    FINANCIAL DATA + active-lens list). The schema is enforced provider-
  //    side via Anthropic forced tool-use / OpenAI strict json_schema /
  //    Gemini responseSchema, so the adapter returns a parsed array directly.
  const systemBlocks = buildSystemBlocks(tier, activeLenses);
  const userMessage = buildUserMessage(tier, tenantData, activeLenses);

  // Diagnostic logging: surface the values reaching the LLM so a misaligned
  // KEY SIGNALS payload (e.g., a net-worth figure that doesn't match the
  // portfolio holdings page) is visible in the logs without re-running.
  // Truncated/sampled to keep log volume reasonable on every run.
  const systemBlockSizes = systemBlocks.map((b) => ({ kind: b.kind, chars: b.text.length }));
  const userMessageChars = userMessage.length;
  const netWorthSample = Array.isArray(tenantData.netWorthHistory) && tenantData.netWorthHistory.length > 0
    ? {
        entries: tenantData.netWorthHistory.length,
        first: tenantData.netWorthHistory[0],
        last: tenantData.netWorthHistory[tenantData.netWorthHistory.length - 1],
      }
    : null;
  logger.info('Insight LLM call about to fire', {
    tenantId, tier, periodKey, activeLenses,
    systemBlockSizes, userMessageChars,
    netWorthSample,
    portfolioCurrency: tenantData.portfolioCurrency,
    targetPeriod: tenantData.targetPeriod,
  });

  const llmStart = Date.now();
  const rawInsights = await generateInsightContent({
    systemBlocks,
    userMessage,
    schema: insightArraySchema,
  });
  logger.info('Insight LLM call returned', {
    tenantId, tier, periodKey,
    durationMs: Date.now() - llmStart,
    insightsReturned: Array.isArray(rawInsights) ? rawInsights.length : 0,
    lensesReturned: Array.isArray(rawInsights) ? rawInsights.map((i) => i?.lens).filter(Boolean) : [],
  });

  if (!Array.isArray(rawInsights) || rawInsights.length === 0) {
    // Surface this as a "skipped" outcome the same way completeness gates
    // and dedup do — the worker hands the same shape back to the API and
    // the frontend renders the "No insights for this period yet — try
    // regenerating in a few minutes" empty state.
    logger.warn('LLM returned no insights:', { tenantId, tier });
    return { skipped: true, reason: 'No insights for this period yet — try regenerating in a few minutes' };
  }

  // 6. Validate, enrich, and store (additive — no deletion)
  const batchId = crypto.randomUUID();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiresAt = computeExpiresAt(tier);

  const insightRecords = rawInsights
    .filter((i) => i.lens && i.title && i.body)
    .map((i) => {
      // Auto-assign category from lens if LLM didn't provide it
      const category = VALID_CATEGORIES.includes(i.category)
        ? i.category
        : LENS_CATEGORY_MAP[i.lens] || 'SPENDING';

      // Validate and enrich metadata
      const metadata = i.metadata || {};
      if (Array.isArray(i.metadata?.actionTypes)) {
        metadata.actionTypes = i.metadata.actionTypes.filter((t) => VALID_ACTION_TYPES.includes(t));
      }

      return {
        tenantId,
        batchId,
        date: today,
        lens: i.lens,
        title: String(i.title).slice(0, 255),
        body: String(i.body),
        severity: VALID_SEVERITIES.includes(i.severity) ? i.severity : 'INFO',
        priority: typeof i.priority === 'number' ? Math.min(Math.max(Math.round(i.priority), 1), 100) : 50,
        dataHash,
        metadata,
        tier,
        category,
        periodKey,
        expiresAt,
      };
    });

  if (insightRecords.length === 0) {
    logger.warn('No valid insights after validation:', { tenantId, tier });
    return { skipped: true, reason: 'No insights for this period yet — try regenerating in a few minutes' };
  }

  // Preserve dismissed state: check if any previous insights for same lens+periodKey were dismissed
  const previousDismissals = await prisma.insight.findMany({
    where: {
      tenantId,
      tier,
      periodKey,
      dismissed: true,
    },
    select: { lens: true },
  });
  const dismissedLenses = new Set(previousDismissals.map((d) => d.lens));

  // Apply dismissed state to matching new insights
  for (const record of insightRecords) {
    if (dismissedLenses.has(record.lens)) {
      record.dismissed = true;
    }
  }

  // When the user explicitly forced a regeneration, replace the previous
  // batch for this (tenantId, tier, periodKey) instead of layering a second
  // batch on top. The user's intent on "Regenerate" is a fresh take, not
  // historical archaeology — and a layered list of 8 stale + 8 fresh
  // insights for the same March is confusing.
  //
  // The cron path (force = false) keeps additive behavior so historical
  // batches accumulate cleanly across the year.
  let deletedPrevious = 0;
  if (force) {
    const deletion = await prisma.insight.deleteMany({
      where: { tenantId, tier, periodKey },
    });
    deletedPrevious = deletion.count;
    if (deletedPrevious > 0) {
      logger.info('Force regenerate: cleared previous batch(es) for this period', {
        tenantId, tier, periodKey, deletedPrevious,
      });
    }
  }

  await prisma.insight.createMany({ data: insightRecords });

  logger.info('Tiered insight generation complete:', {
    tenantId,
    tier,
    batchId,
    periodKey,
    insightCount: insightRecords.length,
    lenses: insightRecords.map((i) => i.lens),
    deletedPrevious,
    forceRegenerate: !!force,
  });

  return { insights: insightRecords, batchId, periodKey, deletedPrevious };
}

/**
 * Generate all tiers that are due for a tenant.
 * Called by the daily cron — checks which tiers should run today.
 *
 * Note: the daily cron is retained purely as a scheduling heartbeat so
 * monthly / quarterly / annual tiers can auto-trigger on their calendar
 * windows. There is no DAILY tier any more.
 */
async function generateAllDueTiers(tenantId) {
  const now = new Date();
  const results = {};

  // Monthly: check if yesterday was the last day of a month
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const lastDayOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  if (now.getDate() <= 3) {
    // We're in the first 3 days of a new month — generate monthly for previous month
    const prevMonth = yesterday.getMonth() + 1;
    const prevYear = yesterday.getFullYear();
    results.MONTHLY = await generateTieredInsights(tenantId, 'MONTHLY', {
      year: prevYear,
      month: prevMonth,
      periodKey: `${prevYear}-${String(prevMonth).padStart(2, '0')}`,
    });
  }

  // Quarterly: check if we're in the first 5 days after a quarter ends
  const currentMonth = now.getMonth() + 1; // 1-12
  if (currentMonth % 3 === 1 && now.getDate() <= 5) {
    // First 5 days of Jan/Apr/Jul/Oct — generate quarterly for previous quarter
    let prevQuarter = getQuarterFromMonth(currentMonth) - 1;
    let prevQYear = now.getFullYear();
    if (prevQuarter <= 0) { prevQuarter = 4; prevQYear -= 1; }
    results.QUARTERLY = await generateTieredInsights(tenantId, 'QUARTERLY', {
      year: prevQYear,
      quarter: prevQuarter,
      periodKey: `${prevQYear}-Q${prevQuarter}`,
    });
  }

  // Annual: check if we're in the first 5 days of January
  if (currentMonth === 1 && now.getDate() <= 5) {
    const prevYear = now.getFullYear() - 1;
    results.ANNUAL = await generateTieredInsights(tenantId, 'ANNUAL', {
      year: prevYear,
      periodKey: `${prevYear}`,
    });
  }

  return results;
}

module.exports = {
  generateTieredInsights,
  generateAllDueTiers,
  derivePeriodKey,
  gatherMonthlyData,
  gatherQuarterlyData,
  gatherAnnualData,
  gatherPortfolioIntelligenceData,
  gatherEquityFundamentals,
  gatherPassiveIncomeRecent,
  buildTieredPrompt,
  filterActiveLenses,
  TIER_LENSES,
  LENS_CATEGORY_MAP,
  VALID_TIERS,
  VALID_CATEGORIES,
};
