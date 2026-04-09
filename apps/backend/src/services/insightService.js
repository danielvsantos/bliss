const crypto = require('crypto');
const prisma = require('../../prisma/prisma.js');
const logger = require('../utils/logger');
const { generateInsightContent } = require('./geminiService');
const { getOrCreateCurrencyRate, getRatesForDateRange } = require('./currencyService');
const { checkTierCompleteness, getPeriodKey, getQuarterMonths, getQuarterFromMonth } = require('./dataCompletenessService');

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_TIERS = ['DAILY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'PORTFOLIO'];

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
  DAILY: ['SPENDING_VELOCITY', 'UNUSUAL_SPENDING', 'CATEGORY_CONCENTRATION'],
  MONTHLY: [
    'SPENDING_VELOCITY', 'CATEGORY_CONCENTRATION',
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
  DAILY: 90,
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

async function convertAmount(amount, fromCurrency, toCurrency, date, rateCache) {
  if (!fromCurrency || fromCurrency === toCurrency || amount === 0) return amount;
  const rate = await getOrCreateCurrencyRate(date, fromCurrency, toCurrency, rateCache);
  if (!rate) return amount;
  return Number(rate) * amount;
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

  const monthlyData = {};
  for (const entry of analyticsData) {
    const key = `${entry.year}-${String(entry.month).padStart(2, '0')}`;
    if (!monthlyData[key]) monthlyData[key] = { income: 0, expenses: 0, groups: {} };
    const netAmount = Math.abs(Number(entry.balance || 0));

    if (entry.type === 'Income') {
      monthlyData[key].income += netAmount;
    } else if (['Essentials', 'Lifestyle', 'Growth'].includes(entry.type)) {
      monthlyData[key].expenses += netAmount;
      const group = entry.group || 'Other';
      monthlyData[key].groups[group] = (monthlyData[key].groups[group] || 0) + netAmount;
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
  const portfolioItems = await prisma.portfolioItem.findMany({
    where: { tenantId },
    include: {
      category: { select: { name: true, group: true, type: true } },
      debtTerms: true,
    },
  });

  // Pre-fetch rates for portfolio items
  const today = new Date();
  for (const p of portfolioItems) {
    if (p.currency && p.currency !== portfolioCurrency) {
      const key = `${p.currency}->${portfolioCurrency}`;
      const ratesMap = await getRatesForDateRange(today, today, p.currency, portfolioCurrency);
      for (const [dateStr, rate] of ratesMap.entries()) {
        rateCache[`${dateStr}_${p.currency}_${portfolioCurrency}`] = rate;
      }
    }
  }

  // Portfolio exposure
  const investments = portfolioItems.filter((p) => p.category?.type === 'Investments');
  const investmentValues = await Promise.all(investments.map(async (p) => {
    const rawValue = Math.abs(Number(p.currentValue || 0));
    const converted = await convertAmount(rawValue, p.currency, portfolioCurrency, today, rateCache);
    return { item: p, value: converted };
  }));
  const totalInvestmentValue = investmentValues.reduce((sum, iv) => sum + iv.value, 0);
  const portfolioExposure = investmentValues.map((iv) => ({
    name: iv.item.name,
    symbol: iv.item.ticker || iv.item.symbol,
    value: Math.round(iv.value * 100) / 100,
    percent: totalInvestmentValue > 0
      ? Math.round((iv.value / totalInvestmentValue) * 10000) / 100
      : 0,
  }));

  // Debt health
  const debts = portfolioItems.filter((p) => p.category?.type === 'Debt');
  const debtHealth = await Promise.all(debts.map(async (p) => {
    const rawBalance = Math.abs(Number(p.currentValue || 0));
    const convertedBalance = await convertAmount(rawBalance, p.currency, portfolioCurrency, today, rateCache);
    const rawMinPayment = p.debtTerms?.minimumPayment ? Number(p.debtTerms.minimumPayment) : null;
    const convertedMinPayment = rawMinPayment !== null
      ? await convertAmount(rawMinPayment, p.currency, portfolioCurrency, today, rateCache)
      : null;
    return {
      name: p.name,
      balance: Math.round(convertedBalance * 100) / 100,
      interestRate: p.debtTerms?.interestRate ? Number(p.debtTerms.interestRate) : null,
      minimumPayment: convertedMinPayment !== null ? Math.round(convertedMinPayment * 100) / 100 : null,
      termInMonths: p.debtTerms?.termInMonths ? Number(p.debtTerms.termInMonths) : null,
      originationDate: p.debtTerms?.originationDate || null,
    };
  }));

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
 */
async function gatherNetWorthHistory(tenantId, startDate, portfolioCurrency, rateCache) {
  const portfolioHistory = await prisma.portfolioValueHistory.findMany({
    where: {
      asset: { tenantId },
      date: { gte: startDate },
    },
    orderBy: { date: 'asc' },
  });

  // Pre-fetch USD -> portfolio currency rates if needed
  if (portfolioCurrency !== 'USD' && portfolioHistory.length > 0) {
    const minDate = new Date(portfolioHistory[0].date);
    const maxDate = new Date(portfolioHistory[portfolioHistory.length - 1].date);
    const ratesMap = await getRatesForDateRange(minDate, maxDate, 'USD', portfolioCurrency);
    for (const [dateStr, rate] of ratesMap.entries()) {
      rateCache[`${dateStr}_USD_${portfolioCurrency}`] = rate;
    }
  }

  const netWorthHistory = await Promise.all(portfolioHistory.map(async (h) => {
    const usdValue = Number(h.valueInUSD || 0);
    const convertedValue = await convertAmount(usdValue, 'USD', portfolioCurrency, h.date, rateCache);
    return {
      date: h.date.toISOString().slice(0, 10),
      value: Math.round(convertedValue * 100) / 100,
    };
  }));

  return netWorthHistory;
}

/**
 * Gather SecurityMaster fundamentals for portfolio holdings.
 * Used by PORTFOLIO tier.
 */
async function gatherEquityFundamentals(tenantId) {
  const holdings = await prisma.portfolioItem.findMany({
    where: {
      tenantId,
      quantity: { gt: 0 },
      ticker: { not: null },
      category: { type: 'Investments' },
    },
    select: {
      id: true,
      name: true,
      ticker: true,
      symbol: true,
      currency: true,
      currentValue: true,
      costBasis: true,
      quantity: true,
      realizedPnL: true,
    },
  });

  const tickers = holdings.map((h) => h.ticker).filter(Boolean);
  if (tickers.length === 0) return { holdings: [], fundamentals: [] };

  const fundamentals = await prisma.securityMaster.findMany({
    where: { symbol: { in: tickers } },
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
    },
  });

  // Merge holdings with fundamentals
  const fundamentalsMap = new Map(fundamentals.map((f) => [f.symbol, f]));
  const enrichedHoldings = holdings.map((h) => {
    const f = fundamentalsMap.get(h.ticker) || {};
    return {
      symbol: h.ticker,
      name: h.name,
      currentValue: Number(h.currentValue || 0),
      costBasis: Number(h.costBasis || 0),
      quantity: Number(h.quantity || 0),
      unrealizedPnL: Number(h.currentValue || 0) - Number(h.costBasis || 0),
      sector: f.sector || 'Unknown',
      industry: f.industry || 'Unknown',
      country: f.country || 'Unknown',
      peRatio: f.peRatio ? Number(f.peRatio) : null,
      dividendYield: f.dividendYield ? Number(f.dividendYield) : null,
      trailingEps: f.trailingEps ? Number(f.trailingEps) : null,
      week52High: f.week52High ? Number(f.week52High) : null,
      week52Low: f.week52Low ? Number(f.week52Low) : null,
      assetType: f.assetType || 'Unknown',
    };
  });

  // Compute sector allocation
  const totalValue = enrichedHoldings.reduce((sum, h) => sum + Math.abs(h.currentValue), 0);
  const sectorAllocation = {};
  for (const h of enrichedHoldings) {
    const sector = h.sector || 'Unknown';
    if (!sectorAllocation[sector]) sectorAllocation[sector] = { value: 0, count: 0, holdings: [] };
    sectorAllocation[sector].value += Math.abs(h.currentValue);
    sectorAllocation[sector].count++;
    sectorAllocation[sector].holdings.push(h.symbol);
  }
  for (const sector of Object.keys(sectorAllocation)) {
    sectorAllocation[sector].percent = totalValue > 0
      ? Math.round((sectorAllocation[sector].value / totalValue) * 10000) / 100
      : 0;
  }

  return {
    holdings: enrichedHoldings,
    sectorAllocation,
    totalValue: Math.round(totalValue * 100) / 100,
  };
}

// ─── Tier-Specific Data Gathering ────────────────────────────────────────────

/**
 * Gather data for Daily Pulse tier.
 * Lightweight: last 30 days vs prior 30 days.
 */
async function gatherDailyData(tenantId) {
  const ctx = await getTenantContext(tenantId);
  const now = new Date();

  // Build month list covering last 60 days
  const months = [];
  for (let i = 0; i < 3; i++) {
    let m = now.getMonth() + 1 - i;
    let y = now.getFullYear();
    if (m <= 0) { m += 12; y -= 1; }
    months.push({ year: y, month: m });
  }

  const analytics = await gatherAnalyticsData(tenantId, months, ctx.portfolioCurrency);
  const spendingVelocity = computeSpendingVelocity(analytics.monthlyData, analytics.sortedMonths, 3);

  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const categoryConcentration = computeCategoryConcentration(analytics.monthlyData, currentMonthKey);

  return {
    tier: 'DAILY',
    portfolioCurrency: ctx.portfolioCurrency,
    months: analytics.sortedMonths,
    spendingVelocity,
    categoryConcentration,
    hasTransactions: analytics.hasTransactions,
  };
}

/**
 * Gather data for Monthly Review tier.
 * Full month data with comparisons to prior month and same month last year.
 */
async function gatherMonthlyData(tenantId, year, month, comparisonAvailable) {
  const ctx = await getTenantContext(tenantId);

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

  // Net worth (6 months back)
  const sixMonthsAgo = new Date(year, month - 7, 1);
  const netWorthHistory = await gatherNetWorthHistory(tenantId, sixMonthsAgo, ctx.portfolioCurrency, ctx.rateCache);

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

  // Net worth (12 months back for quarterly context)
  const twelveMonthsAgo = new Date(year, targetMonths[0] - 13, 1);
  const netWorthHistory = await gatherNetWorthHistory(tenantId, twelveMonthsAgo, ctx.portfolioCurrency, ctx.rateCache);

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

  // Net worth (3 years back)
  const threeYearsAgo = new Date(year - 2, 0, 1);
  const netWorthHistory = await gatherNetWorthHistory(tenantId, threeYearsAgo, ctx.portfolioCurrency, ctx.rateCache);

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
    hasTransactions: analytics.hasTransactions,
    comparisonAvailable,
  };
}

/**
 * Gather data for Portfolio Intelligence tier.
 * Current holdings + SecurityMaster fundamentals.
 */
async function gatherPortfolioIntelligenceData(tenantId) {
  const ctx = await getTenantContext(tenantId);
  const portfolio = await gatherPortfolioData(tenantId, ctx.portfolioCurrency, ctx.rateCache);
  const equityData = await gatherEquityFundamentals(tenantId);

  return {
    tier: 'PORTFOLIO',
    portfolioCurrency: ctx.portfolioCurrency,
    ...portfolio,
    equityHoldings: equityData.holdings,
    sectorAllocation: equityData.sectorAllocation,
    totalEquityValue: equityData.totalValue,
    hasPortfolio: portfolio.hasPortfolio,
  };
}

// ─── Prompt Templates ────────────────────────────────────────────────────────

function getBaseVoiceRules(symbol, currency) {
  return `CURRENCY:
- The user's portfolio currency is ${currency}. All monetary values are in ${currency}.
- Always format amounts with ${symbol} for ${currency}.

VOICE RULES:
- Write as a sophisticated financial concierge who has been quietly watching.
- Never use exclamation points. Never say "Great news!" or "Watch out!"
- Open with the observation itself, not preamble.
- Use precise numbers. "${symbol}847" not "increased significantly."
- Never give explicit financial advice. Observe, contextualize, let the user decide.

SEVERITY GUIDE:
- POSITIVE: A favorable trend (savings up, debt declining, income stable)
- INFO: A neutral observation worth noting (spending shift, new category)
- WARNING: Something deserving attention (single category >40% of spend, savings declining 3+ months)
- CRITICAL: A pattern that could cause financial stress if unchecked (expenses > income, debt climbing)`;
}

function getActionTypeInstructions() {
  return `ACTION TYPES (assign 1-2 per insight in metadata.actionTypes):
${VALID_ACTION_TYPES.map((t) => `- ${t}`).join('\n')}

RELATED LENSES (in metadata.relatedLenses, list other lenses that tell a connected story):
For example, if spending velocity is high AND savings rate is dropping, link them.

SUGGESTED ACTION (in metadata.suggestedAction):
A single sentence suggesting what the user might consider. Frame as an option, not advice.
Example: "Consider reviewing your dining budget based on the 3-month average."`;
}

const PROMPT_TEMPLATES = {
  DAILY: (symbol, currency) => `You are Bliss, a financial intelligence system running a DAILY PULSE scan.
Your job: detect anomalies and notable changes in the last 30 days. Be brief and alert-focused.

${getBaseVoiceRules(symbol, currency)}

DAILY PULSE RULES:
- Only produce insights if something is GENUINELY notable (>15% swing, new pattern, unusual spike).
- If nothing stands out, return an empty array []. Do NOT force insights.
- Maximum 3 insights. Most days should produce 0-1.
- Each insight: 1-2 sentences. Alert-style. "${symbol}X amount spent on Y this week — that's Z% above your 90-day average."
- Title: 6 words max.

${getActionTypeInstructions()}

Return a JSON array where each insight has:
{ "lens", "title" (6 words max), "body" (1-2 sentences), "severity", "priority" (1-100), "category", "metadata": { "dataPoints": {...}, "actionTypes": [...], "relatedLenses": [...], "suggestedAction": "..." } }`,

  MONTHLY: (symbol, currency) => `You are Bliss, a financial intelligence system producing a MONTHLY REVIEW.
Analyze the completed month comprehensively. Compare to prior month and same month last year when available.

${getBaseVoiceRules(symbol, currency)}

MONTHLY REVIEW RULES:
- Produce exactly one insight per lens provided.
- Each insight: 2-4 sentences with specific numbers.
- Title: 8 words max.
- When year-over-year data is available, always reference it for seasonal context.
- When comparison data is unavailable, note "No prior comparison available" and focus on the month's standalone metrics.

${getActionTypeInstructions()}

Return a JSON array where each insight has:
{ "lens", "title" (8 words max), "body" (2-4 sentences), "severity", "priority" (1-100), "category", "metadata": { "dataPoints": {...}, "actionTypes": [...], "relatedLenses": [...], "suggestedAction": "..." } }`,

  QUARTERLY: (symbol, currency) => `You are Bliss, a financial intelligence system producing a QUARTERLY DEEP DIVE.
This is a strategic analysis. Look for trends, seasonal patterns, and emerging trajectories across 3 months.

${getBaseVoiceRules(symbol, currency)}

QUARTERLY DEEP DIVE RULES:
- Produce 1-2 insights per lens provided (more depth is allowed for quarterly).
- Each insight: 3-5 sentences. Connect dots across months. Identify emerging patterns.
- Title: 10 words max.
- Compare to prior quarter AND same quarter last year when available.
- Highlight seasonal patterns explicitly ("Q1 traditionally shows..." when data supports it).
- For debt: project payoff timelines at current payment rate.
- For savings: identify the trend direction over the quarter.

${getActionTypeInstructions()}

Return a JSON array where each insight has:
{ "lens", "title" (10 words max), "body" (3-5 sentences), "severity", "priority" (1-100), "category", "metadata": { "dataPoints": {...}, "actionTypes": [...], "relatedLenses": [...], "suggestedAction": "..." } }`,

  ANNUAL: (symbol, currency) => `You are Bliss, a financial intelligence system producing an ANNUAL REPORT.
This is the most comprehensive analysis — a year-in-review. Think big-picture trends, milestones, and trajectory.

${getBaseVoiceRules(symbol, currency)}

ANNUAL REPORT RULES:
- Produce 2-3 insights per CATEGORY (not per lens). Group related lenses into cohesive narratives.
- Each insight: 4-6 sentences. Year-in-review narrative style.
- Title: 12 words max.
- Compare to prior year(s) when available. Highlight year-over-year shifts.
- Celebrate milestones (net worth crossing thresholds, debt payoff progress, savings rate improvements).
- Identify the single biggest positive and negative financial event of the year.
- For portfolio: reference total return, not just current value.

${getActionTypeInstructions()}

Return a JSON array where each insight has:
{ "lens", "title" (12 words max), "body" (4-6 sentences), "severity", "priority" (1-100), "category", "metadata": { "dataPoints": {...}, "actionTypes": [...], "relatedLenses": [...], "suggestedAction": "..." } }`,

  PORTFOLIO: (symbol, currency) => `You are Bliss, a financial intelligence system producing PORTFOLIO INTELLIGENCE.
Analyze equity holdings using fundamental data. Think like an investment analyst reviewing a personal portfolio.

${getBaseVoiceRules(symbol, currency)}

PORTFOLIO INTELLIGENCE RULES:
- Produce exactly one insight per lens provided.
- Each insight: 2-4 sentences referencing specific fundamentals (P/E, yield, EPS, 52W range).
- Title: 8 words max.
- SECTOR_CONCENTRATION: Flag if any sector exceeds 40% allocation. Reference diversification.
- VALUATION_RISK: Compare P/E ratios to reasonable ranges (15-25 for growth, 10-18 for value). Flag outliers.
- DIVIDEND_OPPORTUNITY: Highlight meaningful yields (>2%) and any recent yield changes.
- PORTFOLIO_EXPOSURE: Identify top 3 holdings by weight. Flag if top holding exceeds 25%.
- Never recommend specific trades. Observe allocation, valuation, and yield.

${getActionTypeInstructions()}

Return a JSON array where each insight has:
{ "lens", "title" (8 words max), "body" (2-4 sentences), "severity", "priority" (1-100), "category", "metadata": { "dataPoints": {...}, "actionTypes": [...], "relatedLenses": [...], "suggestedAction": "..." } }`,
};

// ─── Prompt Builder ──────────────────────────────────────────────────────────

function buildTieredPrompt(tier, tenantData, activeLenses) {
  const symbol = CURRENCY_SYMBOLS[tenantData.portfolioCurrency] || tenantData.portfolioCurrency;
  const systemPrompt = PROMPT_TEMPLATES[tier](symbol, tenantData.portfolioCurrency);

  // Build data section - exclude internal fields
  const { tier: _t, hasTransactions, hasPortfolio, hasDebt, comparisonAvailable, ...dataForPrompt } = tenantData;

  const dataSection = JSON.stringify(dataForPrompt, null, 2);

  return `${systemPrompt}

ACTIVE LENSES (produce insights for these lenses):
${activeLenses.join(', ')}

COMPARISON DATA AVAILABILITY:
${JSON.stringify(comparisonAvailable || {}, null, 2)}

FINANCIAL DATA:
${dataSection}`;
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
    case 'DAILY':
      tenantData = await gatherDailyData(tenantId);
      break;
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
  const periodKey = params.periodKey || getPeriodKey(tier, new Date());

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

  // 5. Build prompt and call LLM
  const prompt = buildTieredPrompt(tier, tenantData, activeLenses);
  const useFastModel = tier === 'DAILY';
  const rawInsights = await generateInsightContent(prompt, { useFastModel });

  if (!Array.isArray(rawInsights) || rawInsights.length === 0) {
    logger.warn('LLM returned no insights:', { tenantId, tier });
    return { insights: [], reason: 'LLM returned empty response' };
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
    return { insights: [], reason: 'All insights failed validation' };
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

  // Additive insert (no deletion of old batches)
  await prisma.insight.createMany({ data: insightRecords });

  logger.info('Tiered insight generation complete:', {
    tenantId,
    tier,
    batchId,
    periodKey,
    insightCount: insightRecords.length,
    lenses: insightRecords.map((i) => i.lens),
  });

  return { insights: insightRecords, batchId, periodKey };
}

/**
 * Legacy compatibility: generate insights using the old v0 flow.
 * Maps to DAILY tier with automatic period key.
 */
async function generateInsights(tenantId) {
  return generateTieredInsights(tenantId, 'DAILY');
}

/**
 * Generate all tiers that are due for a tenant.
 * Called by the daily cron — checks which tiers should run today.
 */
async function generateAllDueTiers(tenantId) {
  const now = new Date();
  const results = {};

  // Daily always runs
  results.DAILY = await generateTieredInsights(tenantId, 'DAILY');

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
  generateInsights,
  generateAllDueTiers,
  gatherDailyData,
  gatherMonthlyData,
  gatherQuarterlyData,
  gatherAnnualData,
  gatherPortfolioIntelligenceData,
  gatherEquityFundamentals,
  buildTieredPrompt,
  filterActiveLenses,
  TIER_LENSES,
  LENS_CATEGORY_MAP,
  VALID_TIERS,
  VALID_CATEGORIES,
};
