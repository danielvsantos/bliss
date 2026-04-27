/**
 * Pre-computed analytical signals for the LLM.
 *
 * Lifts the bulk of "compute deltas, identify movers, find anomalies" work
 * out of the model and into deterministic JS. The LLM still writes the
 * prose — that's its job — but it no longer has to do the arithmetic to
 * find the things worth writing about. Net effect: fewer numeric mistakes,
 * tighter and more consistent observations, and a smaller user message
 * (the model needs less raw monthlyData to chew on).
 *
 * Returned object is serialised at the top of the user message under a
 * `KEY SIGNALS:` heading. Shape is intentionally shallow / readable so
 * the model can pick up the relevant facts in one pass.
 */

const STDEV_THRESHOLD = 2;
const TOP_MOVERS_COUNT = 3;
const SHARE_BASELINE_WINDOW = 6;
const ANOMALY_HISTORY_WINDOW = 6;

/** Sum amounts in a per-month groups map. */
function sumGroupValues(groups) {
  if (!groups) return 0;
  return Object.values(groups).reduce((s, v) => s + (v || 0), 0);
}

/** mean and stdev of an array, returning [null, null] for <2 entries. */
function meanStdev(values) {
  const n = values.length;
  if (n < 2) return [n === 1 ? values[0] : null, null];
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return [mean, Math.sqrt(variance)];
}

/** Top N category movers by absolute $ change between two month dictionaries. */
function topMovers(currentGroups, priorGroups, limit = TOP_MOVERS_COUNT) {
  const allGroups = new Set([
    ...Object.keys(currentGroups || {}),
    ...Object.keys(priorGroups || {}),
  ]);
  const movers = [];
  for (const g of allGroups) {
    const cur = currentGroups?.[g] || 0;
    const pri = priorGroups?.[g] || 0;
    const deltaAbs = cur - pri;
    if (deltaAbs === 0) continue;
    movers.push({
      group: g,
      priorAmount: round2(pri),
      currentAmount: round2(cur),
      deltaAbs: round2(deltaAbs),
      deltaPct: pri > 0 ? round1((deltaAbs / pri) * 100) : null,
    });
  }
  movers.sort((a, b) => Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs));
  return movers.slice(0, limit);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/** Compute the share-of-spend for the largest category in `targetGroups`. */
function topCategoryShare(targetGroups, totalSpend) {
  if (!targetGroups || totalSpend <= 0) return null;
  let topGroup = null;
  let topAmount = 0;
  for (const [g, amt] of Object.entries(targetGroups)) {
    if (amt > topAmount) { topGroup = g; topAmount = amt; }
  }
  if (!topGroup) return null;
  return { group: topGroup, amount: round2(topAmount), sharePct: round1((topAmount / totalSpend) * 100) };
}

/** Average baseline share over a backward window of N months for `group`. */
function baselineShareForGroup(monthlyData, sortedMonths, anchorMonthKey, group, windowSize = SHARE_BASELINE_WINDOW) {
  const idx = sortedMonths.indexOf(anchorMonthKey);
  if (idx < 0) return null;
  const start = Math.max(0, idx - windowSize);
  const window = sortedMonths.slice(start, idx);
  if (!window.length) return null;
  const shares = [];
  for (const k of window) {
    const d = monthlyData[k];
    if (!d) continue;
    const total = sumGroupValues(d.groups);
    if (total <= 0) continue;
    shares.push(((d.groups?.[group] || 0) / total) * 100);
  }
  if (!shares.length) return null;
  return round1(shares.reduce((s, v) => s + v, 0) / shares.length);
}

/** Categories whose target-month spend lies more than 2σ above their 6-month mean. */
function findAnomalies(monthlyData, sortedMonths, anchorMonthKey, windowSize = ANOMALY_HISTORY_WINDOW) {
  const idx = sortedMonths.indexOf(anchorMonthKey);
  if (idx < 0) return [];
  const target = monthlyData[anchorMonthKey];
  if (!target?.groups) return [];

  const window = sortedMonths.slice(Math.max(0, idx - windowSize), idx);
  if (window.length < 3) return []; // need a meaningful baseline

  const anomalies = [];
  for (const [group, currentAmount] of Object.entries(target.groups)) {
    const history = window
      .map((k) => monthlyData[k]?.groups?.[group] ?? 0);
    const [mean, stdev] = meanStdev(history);
    if (stdev == null || stdev === 0) continue;
    const sigma = (currentAmount - mean) / stdev;
    if (sigma >= STDEV_THRESHOLD) {
      anomalies.push({
        group,
        currentAmount: round2(currentAmount),
        mean6mo: round2(mean),
        stdev6mo: round2(stdev),
        sigma: round1(sigma),
      });
    }
  }
  return anomalies.sort((a, b) => b.sigma - a.sigma);
}

/** Coefficient of variation of monthly income across the trailing window. */
function incomeStability(incomeHistory) {
  if (!incomeHistory?.length) return null;
  const values = incomeHistory.map((m) => m.income).filter((v) => v != null);
  if (values.length < 2) return null;
  const [mean, stdev] = meanStdev(values);
  if (!mean) return null;
  return { mean: round2(mean), stdev: round2(stdev), cov: round2(stdev / mean) };
}

/**
 * Net worth decomposition: period-anchored totals plus per-group breakdown.
 *
 * `start` / `end` are derived from the breakdown's per-group sums, NOT from
 * the netWorthHistory trend window's first/last entries. The trend window
 * extends 6 / 12 / 36 months back for sparkline context, but the period
 * being analyzed is just one month / quarter / year — the breakdown
 * anchors are the right source of truth for "start" and "end" of the
 * period the insight describes.
 *
 * A previous version used `netWorthHistory[0]` as the start, which silently
 * produced wrong narrative for MONTHLY ("net worth rose from $850k six
 * months ago to $924k today, an 8.7% gain in a single month").
 */
function netWorthDecomposition(netWorthHistory, netWorthBreakdown) {
  const breakdown = Array.isArray(netWorthBreakdown) ? netWorthBreakdown : [];

  let start = null;
  let end = null;

  if (breakdown.length > 0) {
    // Sum across all groups — gives the period-anchored totals that match
    // the per-group attribution the LLM is asked to write about.
    start = breakdown.reduce((s, b) => s + (b.start || 0), 0);
    end = breakdown.reduce((s, b) => s + (b.end || 0), 0);
  } else if (Array.isArray(netWorthHistory) && netWorthHistory.length >= 2) {
    // Fallback for callers that have a trend-window history but no
    // breakdown (PORTFOLIO tier, or any tier where the breakdown query
    // returned empty). Less precise — uses trend-window endpoints — but
    // better than nothing.
    const sorted = [...netWorthHistory].sort((a, b) => new Date(a.date) - new Date(b.date));
    start = sorted[0]?.value;
    end = sorted[sorted.length - 1]?.value;
  }

  if (start == null || end == null) return null;
  const absolute = end - start;
  const pct = start !== 0 ? (absolute / Math.abs(start)) * 100 : null;

  return {
    start: round2(start),
    end: round2(end),
    absolute: round2(absolute),
    pct: pct != null ? round1(pct) : null,
    byAssetType: breakdown,
  };
}

// ─── Tier-specific signal builders ──────────────────────────────────────────

function monthlySignals(tenantData) {
  const { monthlyData = {}, months: sortedMonths = [], targetPeriod, comparisonAvailable } = tenantData;
  const target = monthlyData[targetPeriod] || null;
  if (!target) return { reason: 'No target-month data' };

  const targetIdx = sortedMonths.indexOf(targetPeriod);
  const priorKey = targetIdx > 0 ? sortedMonths[targetIdx - 1] : null;
  const prior = priorKey ? monthlyData[priorKey] : null;
  const yoyKey = (() => {
    const [y, m] = targetPeriod.split('-');
    return `${Number(y) - 1}-${m}`;
  })();
  const yoy = monthlyData[yoyKey] || null;

  const totalSpendCurrent = sumGroupValues(target.groups);
  const totalSpendPrior = prior ? sumGroupValues(prior.groups) : null;

  const top = topCategoryShare(target.groups, totalSpendCurrent);
  const baselineShare = top ? baselineShareForGroup(monthlyData, sortedMonths, targetPeriod, top.group) : null;

  return {
    period: targetPeriod,
    comparisonAvailable: comparisonAvailable || { prior: !!prior, yoy: !!yoy },
    spending: {
      current: round2(totalSpendCurrent),
      prior: totalSpendPrior != null ? round2(totalSpendPrior) : null,
      yoy: yoy ? round2(sumGroupValues(yoy.groups)) : null,
      momPct: totalSpendPrior != null && totalSpendPrior > 0
        ? round1(((totalSpendCurrent - totalSpendPrior) / totalSpendPrior) * 100)
        : null,
    },
    topMovers: prior ? topMovers(target.groups, prior.groups) : [],
    topCategoryShare: top ? { ...top, baseline6moSharePct: baselineShare } : null,
    income: {
      current: round2(target.income || 0),
      prior: prior ? round2(prior.income || 0) : null,
      yoy: yoy ? round2(yoy.income || 0) : null,
      arrived: (target.income || 0) > 0,
      stability: incomeStability(tenantData.incomeHistory),
    },
    savingsRate: (() => {
      const cur = target.income > 0 ? round1(((target.income - target.expenses) / target.income) * 100) : null;
      const pri = prior && prior.income > 0 ? round1(((prior.income - prior.expenses) / prior.income) * 100) : null;
      return cur != null
        ? { current: cur, prior: pri, deltaPP: pri != null ? round1(cur - pri) : null }
        : null;
    })(),
    anomalies: findAnomalies(monthlyData, sortedMonths, targetPeriod),
    netWorth: netWorthDecomposition(tenantData.netWorthHistory, tenantData.netWorthBreakdown),
  };
}

function quarterlySignals(tenantData) {
  const { monthlyData = {}, months: sortedMonths = [], targetPeriod, quarterTotals, comparisonAvailable } = tenantData;

  const totalSpend = quarterTotals?.expenses ?? sumGroupValues(quarterTotals?.groups);
  const top = topCategoryShare(quarterTotals?.groups, totalSpend);

  // Within-quarter savings-rate path
  const quarterMonths = sortedMonths.filter((k) => k.startsWith(targetPeriod.slice(0, 4)) && targetPeriod.includes('Q'));
  const monthlySavingsRates = quarterMonths
    .map((k) => {
      const d = monthlyData[k];
      if (!d || !(d.income > 0)) return null;
      return { month: k, rate: round1(((d.income - d.expenses) / d.income) * 100) };
    })
    .filter(Boolean);

  return {
    period: targetPeriod,
    comparisonAvailable: comparisonAvailable || {},
    quarter: {
      income: round2(quarterTotals?.income || 0),
      expenses: round2(quarterTotals?.expenses || 0),
      savingsRate: quarterTotals?.income > 0
        ? round1(((quarterTotals.income - quarterTotals.expenses) / quarterTotals.income) * 100)
        : null,
    },
    topCategoryShare: top || null,
    monthlySavingsRates,
    income: { stability: incomeStability(tenantData.incomeHistory) },
    netWorth: netWorthDecomposition(tenantData.netWorthHistory, tenantData.netWorthBreakdown),
  };
}

function annualSignals(tenantData) {
  const { monthlyData = {}, months: sortedMonths = [], targetPeriod, comparisonAvailable } = tenantData;
  const yearKey = String(targetPeriod);

  const yearMonths = sortedMonths.filter((k) => k.startsWith(`${yearKey}-`));
  const yearTotals = yearMonths.reduce(
    (acc, k) => {
      const d = monthlyData[k] || {};
      acc.income += d.income || 0;
      acc.expenses += d.expenses || 0;
      for (const [g, amt] of Object.entries(d.groups || {})) {
        acc.groups[g] = (acc.groups[g] || 0) + amt;
      }
      return acc;
    },
    { income: 0, expenses: 0, groups: {} },
  );

  // Quarterly breakdown of savings rate inside the year
  const quarterRates = [1, 2, 3, 4].map((q) => {
    const monthsInQ = q === 1 ? [1, 2, 3] : q === 2 ? [4, 5, 6] : q === 3 ? [7, 8, 9] : [10, 11, 12];
    const totals = monthsInQ.reduce(
      (acc, m) => {
        const d = monthlyData[`${yearKey}-${String(m).padStart(2, '0')}`] || {};
        acc.income += d.income || 0;
        acc.expenses += d.expenses || 0;
        return acc;
      },
      { income: 0, expenses: 0 },
    );
    if (totals.income <= 0) return null;
    return { quarter: `Q${q}`, rate: round1(((totals.income - totals.expenses) / totals.income) * 100) };
  }).filter(Boolean);

  const top = topCategoryShare(yearTotals.groups, yearTotals.expenses);

  return {
    period: yearKey,
    comparisonAvailable: comparisonAvailable || {},
    year: {
      income: round2(yearTotals.income),
      expenses: round2(yearTotals.expenses),
      savingsRate: yearTotals.income > 0
        ? round1(((yearTotals.income - yearTotals.expenses) / yearTotals.income) * 100)
        : null,
    },
    topCategoryShare: top || null,
    quarterlySavingsRates: quarterRates,
    income: { stability: incomeStability(tenantData.incomeHistory) },
    netWorth: netWorthDecomposition(tenantData.netWorthHistory, tenantData.netWorthBreakdown),
  };
}

function portfolioSignals(tenantData) {
  const holdings = tenantData.equityHoldings || [];
  const totalEquity = tenantData.totalEquityValue || holdings.reduce((s, h) => s + (h.currentValue || 0), 0);

  // Top 3 by weight
  const sorted = [...holdings].sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
  const top3 = sorted.slice(0, 3).map((h) => ({
    symbol: h.symbol,
    sharePct: totalEquity > 0 ? round1((h.currentValue / totalEquity) * 100) : null,
  }));

  // Sector concentration
  const sectorAlloc = tenantData.sectorAllocation || {};
  const sectorEntries = Object.entries(sectorAlloc).sort((a, b) => (b[1].value || 0) - (a[1].value || 0));
  const topSector = sectorEntries[0];

  // Industry concentration: sliced one layer below sector. The lens uses this
  // to talk about sub-segments ("Semiconductors at 28%") inside the dominant
  // sector, which is more actionable than the GICS-level rollup alone.
  const industryAlloc = tenantData.industryAllocation || {};
  const industryEntries = Object.entries(industryAlloc).sort((a, b) => (b[1].value || 0) - (a[1].value || 0));
  const topIndustries = industryEntries.slice(0, 3).map(([industry, v]) => ({
    industry,
    sector: v.sector || null,
    sharePct: round1(v.percent || 0),
    holdings: v.holdings || [],
  }));

  // Weighted P/E across trusted holdings
  const trustedPe = holdings.filter((h) => h.peRatio != null && h.peRatio > 0);
  const peWeightSum = trustedPe.reduce((s, h) => s + h.currentValue, 0);
  const weightedPe = peWeightSum > 0
    ? trustedPe.reduce((s, h) => s + h.peRatio * (h.currentValue / peWeightSum), 0)
    : null;

  // Weighted dividend yield across trusted holdings
  const trustedDy = holdings.filter((h) => h.dividendYield != null && h.dividendYield > 0);
  const dyWeightSum = trustedDy.reduce((s, h) => s + h.currentValue, 0);
  const weightedDy = dyWeightSum > 0
    ? trustedDy.reduce((s, h) => s + h.dividendYield * (h.currentValue / dyWeightSum), 0)
    : null;

  // Dividend-paying stock allocation: the correct denominator for yield. If
  // the LLM divides annualized dividends by total equity (or worse, total
  // portfolio) instead of this number, the yield it quotes will be too low
  // and misleading.
  const dividendPayingValue = trustedDy.reduce((s, h) => s + h.currentValue, 0);

  return {
    totalEquity: round2(totalEquity),
    holdingsCount: holdings.length,
    topHoldings: top3,
    topSector: topSector
      ? { sector: topSector[0], sharePct: round1(topSector[1].percent || 0) }
      : null,
    topIndustries,
    weightedPe: weightedPe != null ? round1(weightedPe) : null,
    weightedDividendYieldPct: weightedDy != null ? round1(weightedDy * 100) : null,
    dividendPayingStockValue: round2(dividendPayingValue),
    trustedHoldingsCount: trustedPe.length,
    passiveIncomeRecent: tenantData.passiveIncomeRecent || null,
  };
}

// ─── Public ────────────────────────────────────────────────────────────────

/**
 * Produce a tier-appropriate KEY SIGNALS summary from the gathered tenantData.
 * Pure function — never queries the DB.
 */
function computeKeySignals(tenantData, tier) {
  switch (tier) {
    case 'MONTHLY':   return monthlySignals(tenantData);
    case 'QUARTERLY': return quarterlySignals(tenantData);
    case 'ANNUAL':    return annualSignals(tenantData);
    case 'PORTFOLIO': return portfolioSignals(tenantData);
    default: return null;
  }
}

module.exports = { computeKeySignals };
