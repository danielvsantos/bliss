import prisma from '../prisma/prisma.js';
import { convertCurrency } from '../utils/currencyConversion.js';
import { classifyIncomeAsset, project, HORIZONS } from '@bliss/shared/portfolio';

/**
 * Passive Income Projection (#77) — API-side input loading.
 *
 * `loadInputs()` does every database read and currency lookup; the pure
 * `project()` from `@bliss/shared/portfolio` does the arithmetic. Computed on
 * request (like Equity Analysis): every input is already stored and kept fresh
 * by existing jobs, so nothing is persisted here.
 */

const ESSENTIALS_TYPE = 'Essentials';
const PASSIVE_INCOME_TYPE = 'Income';
const PASSIVE_INCOME_GROUP = 'Passive Income';

function toNumber(v) {
  if (v == null) return null;
  const n = Number(typeof v === 'object' ? v.toString() : v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Per-request FX helper: native → display multiplier, USD as intermediary.
 * Falls back to 1 when no rate is known (same behaviour as Equity Analysis,
 * which shows the unconverted value rather than failing the page).
 */
export function createFxResolver(displayCurrency, asOf = new Date()) {
  const cache = new Map();
  const rateOf = async (from, to) => {
    if (!from || from === to) return 1;
    const key = `${from}->${to}`;
    if (cache.has(key)) return cache.get(key);
    let rate = null;
    const direct = await convertCurrency(1, from, to, asOf);
    if (direct) {
      rate = toNumber(direct);
    } else if (from !== 'USD' && to !== 'USD') {
      const toUsd = await convertCurrency(1, from, 'USD', asOf);
      const fromUsd = toUsd ? await convertCurrency(1, 'USD', to, asOf) : null;
      if (toUsd && fromUsd) rate = toNumber(toUsd) * toNumber(fromUsd);
    }
    const resolved = rate && rate > 0 ? rate : 1;
    cache.set(key, resolved);
    return resolved;
  };
  return (from) => rateOf(from, displayCurrency);
}

function lastMonths(asOf, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1));
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, key: d.toISOString().slice(0, 7) });
  }
  return out;
}

/**
 * Past 12 months of actual passive income (whole "Passive Income" group,
 * current month = month-to-date) and trailing-12-month essential spending,
 * read from AnalyticsCacheMonthly in the display currency. Mirrors the
 * backend's `gatherPassiveIncomeRecent` filters.
 */
async function loadActuals(tenantId, displayCurrency, asOf) {
  const months = lastMonths(asOf, 12);
  const rows = await prisma.analyticsCacheMonthly.findMany({
    where: {
      tenantId,
      currency: displayCurrency,
      OR: [
        { type: PASSIVE_INCOME_TYPE, group: PASSIVE_INCOME_GROUP },
        { type: ESSENTIALS_TYPE },
      ],
      AND: [{ OR: months.map(({ year, month }) => ({ year, month })) }],
    },
    select: { year: true, month: true, type: true, group: true, credit: true, debit: true },
  });

  const income = new Map(months.map((m) => [m.key, 0]));
  let essentials = 0;
  for (const r of rows) {
    const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
    const credit = toNumber(r.credit) || 0;
    const debit = toNumber(r.debit) || 0;
    if (r.type === PASSIVE_INCOME_TYPE && r.group === PASSIVE_INCOME_GROUP) {
      if (income.has(key)) income.set(key, income.get(key) + credit - debit);
    } else if (r.type === ESSENTIALS_TYPE) {
      essentials += debit - credit;
    }
  }
  return {
    actuals: months.map((m) => ({ month: m.key, total: Math.round(income.get(m.key) * 100) / 100 })),
    trailingEssentials: Math.round(essentials * 100) / 100,
  };
}

/**
 * Load every projection input for a tenant.
 * @returns {Promise<{ displayCurrency, assets, streams, detached, actuals, trailingEssentials }>}
 */
export async function loadInputs(tenantId, asOf = new Date()) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { portfolioCurrency: true },
  });
  const displayCurrency = tenant?.portfolioCurrency || 'USD';
  const fx = createFxResolver(displayCurrency, asOf);

  const [items, streamRows, detachedRows, actualsData] = await Promise.all([
    prisma.portfolioItem.findMany({
      where: { tenantId, quantity: { gt: 0 } },
      select: {
        id: true,
        symbol: true,
        currency: true,
        assetCurrency: true,
        quantity: true,
        currentValue: true,
        currentValueInUSD: true,
        category: {
          select: { name: true, type: true, group: true, processingHint: true, defaultCategoryCode: true },
        },
        accountId: true,
        account: { select: { name: true } },
        incomeTerms: true,
      },
      orderBy: { symbol: 'asc' },
    }),
    prisma.incomeTerms.findMany({
      where: { tenantId, categoryId: { not: null } },
      include: { category: { select: { name: true } } },
    }),
    prisma.incomeTerms.findMany({
      where: { tenantId, assetId: null, categoryId: null, orphanedAt: { not: null } },
      orderBy: { orphanedAt: 'desc' },
    }),
    loadActuals(tenantId, displayCurrency, asOf),
  ]);

  const apiSymbols = [
    ...new Set(items.filter((i) => i.category?.processingHint?.startsWith('API_')).map((i) => i.symbol)),
  ];
  const smRows = apiSymbols.length
    ? await prisma.securityMaster.findMany({
        where: { symbol: { in: apiSymbols } },
        select: {
          symbol: true,
          name: true,
          assetType: true,
          currency: true,
          dividendTrusted: true,
          recentDividends: true,
        },
      })
    : [];
  const smMap = new Map(smRows.map((r) => [r.symbol, r]));

  const usdToDisplay = await fx('USD');
  const assets = [];
  for (const item of items) {
    const sm = smMap.get(item.symbol);
    const assetClass = classifyIncomeAsset({ ...item.category, securityAssetType: sm?.assetType });
    if (!assetClass) continue;

    const termsCurrency = item.incomeTerms?.currency || item.currency;
    const fxRate = await fx(termsCurrency);
    let currentValue;
    if (item.currentValueInUSD != null) {
      currentValue = toNumber(item.currentValueInUSD) * usdToDisplay;
    } else {
      currentValue = (toNumber(item.currentValue) || 0) * (await fx(item.currency));
    }

    // Only trusted dividend history is replayed; untrusted → null (not "zero").
    const trusted = sm?.dividendTrusted === true;
    const recentDividends = trusted ? (Array.isArray(sm.recentDividends) ? sm.recentDividends : []) : null;
    const dividendCurrency = sm?.currency || item.assetCurrency || item.currency;

    assets.push({
      id: item.id,
      label: item.account?.name ? `${item.symbol} · ${item.account.name}` : item.symbol,
      symbol: item.symbol,
      // Grouped view (#83): the security name labels a symbol's group row.
      securityName: sm?.name || null,
      accountId: item.accountId ?? null,
      accountName: item.account?.name || null,
      currency: item.currency,
      categoryName: item.category?.name || null,
      assetClass,
      quantity: toNumber(item.quantity),
      currentValue,
      fxRate,
      dividendFxRate: await fx(dividendCurrency),
      hasSecurityData: Boolean(sm),
      recentDividends,
      terms: item.incomeTerms || null,
    });
  }

  const streams = [];
  for (const row of streamRows) {
    streams.push({
      id: row.id,
      name: row.name,
      categoryName: row.category?.name || null,
      fxRate: await fx(row.currency || displayCurrency),
      terms: row,
    });
  }

  return {
    displayCurrency,
    assets,
    streams,
    detached: detachedRows.map((r) => ({
      id: r.id,
      orphanedLabel: r.orphanedLabel,
      orphanedAt: r.orphanedAt,
      incomeType: r.incomeType,
      frequency: r.frequency,
      currency: r.currency,
      maturityDate: r.maturityDate,
      couponRate: toNumber(r.couponRate),
      monthlyRent: toNumber(r.monthlyRent),
      dividendPerUnit: toNumber(r.dividendPerUnit),
      apyPct: toNumber(r.apyPct),
    })),
    actuals: actualsData.actuals,
    trailingEssentials: actualsData.trailingEssentials,
  };
}

/** Parse and validate the `horizon` query param. Returns null when invalid. */
export function parseHorizon(raw) {
  if (raw === undefined || raw === null || raw === '') return 12;
  const n = Number(raw);
  return HORIZONS.includes(n) ? n : null;
}

/**
 * Build the GET /api/portfolio/passive-income response.
 */
export async function getPassiveIncome(tenantId, { horizon = 12, asOf = new Date() } = {}) {
  const inputs = await loadInputs(tenantId, asOf);
  const result = project({
    assets: inputs.assets,
    streams: inputs.streams,
    asOf,
    horizon,
    displayCurrency: inputs.displayCurrency,
  });

  const { totals } = result;
  const essentialsCoveragePct = inputs.trailingEssentials > 0
    ? Math.round((totals.next12mIncome / inputs.trailingEssentials) * 10000) / 100
    : null;

  return {
    displayCurrency: inputs.displayCurrency,
    asOf: result.asOf,
    horizon: result.horizon,
    kpis: {
      next12mIncome: totals.next12mIncome,
      next12mInvestmentIncome: totals.next12mInvestmentIncome,
      next12mOtherIncome: totals.next12mOtherIncome,
      monthlyAverage: totals.monthlyAverage,
      yieldOnValue: totals.yieldOnValue,
      essentialsCoveragePct,
      trailingEssentials: inputs.trailingEssentials,
      coverage: totals.coverage,
      coverageByHolding: totals.coverageByHolding,
    },
    actuals: inputs.actuals,
    projected: result.monthly,
    yearly: result.yearly,
    items: result.items,
    groups: result.groups,
    upcomingPayments: result.upcomingPayments,
    upcomingPaymentsGrouped: result.upcomingPaymentsGrouped,
    maturityLadder: result.maturityLadder,
    detached: inputs.detached,
    missing: result.missing,
    missingGroups: result.missingGroups,
  };
}
