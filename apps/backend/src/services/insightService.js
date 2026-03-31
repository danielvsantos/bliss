const crypto = require('crypto');
const prisma = require('../../prisma/prisma.js');
const logger = require('../utils/logger');
const { generateInsightContent } = require('./geminiService');
const { getOrCreateCurrencyRate, getRatesForDateRange } = require('./currencyService');

// ─── Currency Helpers ─────────────────────────────────────────────────────────

/**
 * Converts an amount between currencies using cached rates.
 * Falls back to the unconverted amount if no rate is available.
 */
async function convertAmount(amount, fromCurrency, toCurrency, date, rateCache) {
  if (!fromCurrency || fromCurrency === toCurrency || amount === 0) return amount;
  const rate = await getOrCreateCurrencyRate(date, fromCurrency, toCurrency, rateCache);
  if (!rate) return amount;
  return Number(rate) * amount;
}

// ─── Lens Definitions ────────────────────────────────────────────────────────

const ALL_LENSES = [
  'SPENDING_VELOCITY',
  'CATEGORY_CONCENTRATION',
  'INCOME_STABILITY',
  'PORTFOLIO_EXPOSURE',
  'DEBT_HEALTH',
  'NET_WORTH_TRAJECTORY',
  'SAVINGS_RATE',
];

// ─── Data Gathering ──────────────────────────────────────────────────────────

/**
 * Gathers all data needed for insight generation for a given tenant.
 * Returns a structured object with derived metrics — NOT raw DB rows.
 */
async function gatherTenantData(tenantId) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // Fetch tenant's portfolio currency
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { portfolioCurrency: true },
  });
  const portfolioCurrency = tenant?.portfolioCurrency || 'USD';
  const rateCache = {}; // In-memory cache for currency rates within this job

  // Calculate 6 months back
  const months = [];
  for (let i = 0; i < 6; i++) {
    let m = currentMonth - i;
    let y = currentYear;
    if (m <= 0) {
      m += 12;
      y -= 1;
    }
    months.push({ year: y, month: m });
  }

  // 1. Analytics cache (spending, income, savings) — filter by portfolio currency
  const analyticsData = await prisma.analyticsCacheMonthly.findMany({
    where: {
      tenantId,
      currency: portfolioCurrency,
      OR: months.map(({ year, month }) => ({ year, month })),
    },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });

  // 2. Portfolio items (for portfolio + debt lenses)
  const portfolioItems = await prisma.portfolioItem.findMany({
    where: { tenantId },
    include: {
      category: { select: { name: true, group: true, type: true } },
      debtTerms: true,
    },
  });

  // 3. Portfolio value history (for net worth trajectory)
  // PortfolioValueHistory doesn't have tenantId — filter through asset relation
  const sixMonthsAgo = new Date(currentYear, currentMonth - 7, 1);
  const portfolioHistory = await prisma.portfolioValueHistory.findMany({
    where: {
      asset: { tenantId },
      date: { gte: sixMonthsAgo },
    },
    orderBy: { date: 'asc' },
  });

  // ─── Bulk Pre-fetch Currency Rates ──────────────────────────────────────
  // Collect all needed currency pairs and date ranges, then batch-fetch from DB.
  // This populates rateCache so individual convertAmount() calls hit cache.
  const currencyPairs = new Map(); // key: "FROM->TO", value: { minDate, maxDate }
  const today = new Date();

  for (const p of portfolioItems) {
    if (p.currency && p.currency !== portfolioCurrency) {
      const key = `${p.currency}->${portfolioCurrency}`;
      if (!currencyPairs.has(key)) {
        currencyPairs.set(key, { minDate: today, maxDate: today });
      }
    }
  }

  if (portfolioCurrency !== 'USD' && portfolioHistory.length > 0) {
    const key = `USD->${portfolioCurrency}`;
    let minDate = new Date(portfolioHistory[0].date);
    let maxDate = new Date(portfolioHistory[portfolioHistory.length - 1].date);
    if (today > maxDate) maxDate = today;
    if (today < minDate) minDate = today;
    currencyPairs.set(key, { minDate, maxDate });
  }

  for (const [pairKey, dates] of currencyPairs.entries()) {
    const [currencyFrom, currencyTo] = pairKey.split('->');
    const ratesMap = await getRatesForDateRange(dates.minDate, dates.maxDate, currencyFrom, currencyTo);
    for (const [dateStr, rate] of ratesMap.entries()) {
      const cacheKey = `${dateStr}_${currencyFrom}_${currencyTo}`;
      rateCache[cacheKey] = rate;
    }
  }

  // ─── Derived Metrics ────────────────────────────────────────────────────

  // Group analytics by month (already filtered to portfolio currency)
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

  // Spending velocity: month-over-month growth by group (last 3 months)
  const sortedMonths = Object.keys(monthlyData).sort();
  const last3 = sortedMonths.slice(-3);
  const spendingVelocity = {};
  if (last3.length >= 2) {
    const prev = monthlyData[last3[last3.length - 2]];
    const curr = monthlyData[last3[last3.length - 1]];
    if (prev && curr) {
      const allGroups = new Set([...Object.keys(prev.groups || {}), ...Object.keys(curr.groups || {})]);
      for (const group of allGroups) {
        const prevAmt = prev.groups?.[group] || 0;
        const currAmt = curr.groups?.[group] || 0;
        if (prevAmt > 0) {
          spendingVelocity[group] = {
            previous: Math.round(prevAmt * 100) / 100,
            current: Math.round(currAmt * 100) / 100,
            changePercent: Math.round(((currAmt - prevAmt) / prevAmt) * 10000) / 100,
          };
        }
      }
    }
  }

  // Category concentration: current month
  const currentMonthKey = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const currentMonthData = monthlyData[currentMonthKey] || { expenses: 0, groups: {} };
  const categoryConcentration = {};
  if (currentMonthData.expenses > 0) {
    for (const [group, amount] of Object.entries(currentMonthData.groups)) {
      categoryConcentration[group] = {
        amount: Math.round(amount * 100) / 100,
        percent: Math.round((amount / currentMonthData.expenses) * 10000) / 100,
      };
    }
  }

  // Income stability: 6-month income series
  const incomeHistory = sortedMonths.map((m) => ({
    month: m,
    income: Math.round((monthlyData[m]?.income || 0) * 100) / 100,
  }));

  // Savings rate per month
  const savingsHistory = sortedMonths.map((m) => {
    const d = monthlyData[m] || { income: 0, expenses: 0 };
    const rate = d.income > 0 ? ((d.income - d.expenses) / d.income) * 100 : 0;
    return { month: m, rate: Math.round(rate * 100) / 100 };
  });

  // Portfolio exposure — convert values to portfolio currency
  const investments = portfolioItems.filter((p) => p.category?.type === 'Investments');
  const investmentValues = await Promise.all(investments.map(async (p) => {
    const rawValue = Math.abs(Number(p.currentValue || 0));
    const converted = await convertAmount(rawValue, p.currency, portfolioCurrency, new Date(), rateCache);
    return { item: p, value: converted };
  }));
  const totalInvestmentValue = investmentValues.reduce((sum, iv) => sum + iv.value, 0);
  const portfolioExposure = investmentValues.map((iv) => ({
    name: iv.item.name,
    value: Math.round(iv.value * 100) / 100,
    percent: totalInvestmentValue > 0
      ? Math.round((iv.value / totalInvestmentValue) * 10000) / 100
      : 0,
  }));

  // Debt health — convert values to portfolio currency
  const debts = portfolioItems.filter((p) => p.category?.type === 'Debt');
  const debtHealth = await Promise.all(debts.map(async (p) => {
    const rawBalance = Math.abs(Number(p.currentValue || 0));
    const convertedBalance = await convertAmount(rawBalance, p.currency, portfolioCurrency, new Date(), rateCache);
    const rawMinPayment = p.debtTerms?.minimumPayment ? Number(p.debtTerms.minimumPayment) : null;
    const convertedMinPayment = rawMinPayment !== null
      ? await convertAmount(rawMinPayment, p.currency, portfolioCurrency, new Date(), rateCache)
      : null;
    return {
      name: p.name,
      balance: Math.round(convertedBalance * 100) / 100,
      interestRate: p.debtTerms?.interestRate ? Number(p.debtTerms.interestRate) : null,
      minimumPayment: convertedMinPayment !== null ? Math.round(convertedMinPayment * 100) / 100 : null,
    };
  }));

  // Net worth trajectory — convert from USD to portfolio currency
  const netWorthHistory = await Promise.all(portfolioHistory.map(async (h) => {
    const usdValue = Number(h.valueInUSD || 0);
    const convertedValue = await convertAmount(usdValue, 'USD', portfolioCurrency, h.date, rateCache);
    return {
      date: h.date.toISOString().slice(0, 10),
      value: Math.round(convertedValue * 100) / 100,
    };
  }));

  return {
    portfolioCurrency,
    months: sortedMonths,
    monthlyData,
    spendingVelocity,
    categoryConcentration,
    incomeHistory,
    savingsHistory,
    portfolioExposure,
    debtHealth,
    netWorthHistory,
    totalInvestmentValue: Math.round(totalInvestmentValue * 100) / 100,
    totalDebt: debtHealth.reduce((sum, d) => sum + d.balance, 0),
    hasTransactions: analyticsData.length > 0,
    hasPortfolio: portfolioItems.length > 0,
    hasDebt: debts.length > 0,
  };
}

// ─── Prompt Construction ─────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are Bliss, a financial intelligence system. You observe patterns in personal
finance data and surface observations that matter.

CURRENCY:
- The user's portfolio currency is {{CURRENCY}}. All monetary values in the data have been converted to {{CURRENCY}}.
- Always format amounts with the correct currency symbol ({{SYMBOL}}) for {{CURRENCY}}.

VOICE RULES:
- Write as a sophisticated financial concierge who has been quietly watching.
- Never use exclamation points. Never say "Great news!" or "Watch out!"
- Open with the observation itself, not preamble.
- Use precise numbers. "Your dining spend rose 23% to {{SYMBOL}}847" not "increased significantly."
- One short paragraph per insight (2-4 sentences maximum).
- When data tells a clear story, state it directly. When ambiguous, say so.
- Never give explicit financial advice. Observe, contextualize, let the user decide.

SEVERITY GUIDE:
- POSITIVE: A favorable trend (savings up, debt declining, income stable)
- INFO: A neutral observation worth noting (spending shift, new category)
- WARNING: Something deserving attention (single category >40% of spend, savings declining 3+ months)
- CRITICAL: A pattern that could cause financial stress if unchecked (expenses > income, debt climbing)

MINIMUM DATA RULES:
- If a lens has <2 months of data, produce a single INFO "Not enough data yet" insight with priority 10.
- Never fabricate numbers.
- Produce exactly one insight per lens provided. No more, no less.

Return a JSON array where each insight has:
{ "lens", "title" (8 words max), "body" (2-4 sentences with specific numbers), "severity", "priority" (1-100), "metadata": { "dataPoints": {...} } }`;

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', BRL: 'R$', JPY: '¥', CNY: '¥',
  AUD: 'A$', CAD: 'C$', CHF: 'CHF', INR: '₹', KRW: '₩', MXN: 'MX$',
};

function getSystemPrompt(portfolioCurrency) {
  const symbol = CURRENCY_SYMBOLS[portfolioCurrency] || portfolioCurrency;
  return SYSTEM_PROMPT_TEMPLATE
    .replace(/\{\{CURRENCY\}\}/g, portfolioCurrency)
    .replace(/\{\{SYMBOL\}\}/g, symbol);
}

function buildInsightPrompt(tenantData, activeLenses) {
  const systemPrompt = getSystemPrompt(tenantData.portfolioCurrency);

  const dataSection = JSON.stringify({
    portfolioCurrency: tenantData.portfolioCurrency,
    months: tenantData.months,
    spendingVelocity: tenantData.spendingVelocity,
    categoryConcentration: tenantData.categoryConcentration,
    incomeHistory: tenantData.incomeHistory,
    savingsHistory: tenantData.savingsHistory,
    portfolioExposure: tenantData.portfolioExposure,
    debtHealth: tenantData.debtHealth,
    netWorthHistory: tenantData.netWorthHistory,
    totalInvestmentValue: tenantData.totalInvestmentValue,
    totalDebt: tenantData.totalDebt,
  }, null, 2);

  return `${systemPrompt}

ACTIVE LENSES (produce exactly one insight per lens):
${activeLenses.join(', ')}

FINANCIAL DATA:
${dataSection}`;
}

// ─── Full Orchestration ──────────────────────────────────────────────────────

/**
 * Generates insights for a single tenant.
 * 1. Gathers data
 * 2. Checks dataHash to skip if unchanged
 * 3. Filters lenses based on data availability
 * 4. Calls Gemini
 * 5. Stores results
 */
async function generateInsights(tenantId) {
  logger.info('Starting insight generation:', { tenantId });

  // 1. Gather data
  const tenantData = await gatherTenantData(tenantId);

  if (!tenantData.hasTransactions && !tenantData.hasPortfolio) {
    logger.info('Skipping insight generation — no data:', { tenantId });
    return [];
  }

  // 2. Compute dataHash
  const hashInput = JSON.stringify({
    m: tenantData.monthlyData,
    sv: tenantData.spendingVelocity,
    cc: tenantData.categoryConcentration,
    pe: tenantData.portfolioExposure,
    dh: tenantData.debtHealth,
    nw: tenantData.netWorthHistory,
  });
  const dataHash = crypto.createHash('sha256').update(hashInput).digest('hex');

  // Check if previous batch has same hash
  const latestInsight = await prisma.insight.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: { dataHash: true, batchId: true },
  });

  if (latestInsight?.dataHash === dataHash) {
    logger.info('Data unchanged since last batch, skipping generation:', { tenantId, dataHash });
    return [];
  }

  // 3. Filter lenses
  const activeLenses = ALL_LENSES.filter((lens) => {
    switch (lens) {
      case 'PORTFOLIO_EXPOSURE':
        return tenantData.portfolioExposure.length > 0;
      case 'DEBT_HEALTH':
        return tenantData.hasDebt;
      case 'NET_WORTH_TRAJECTORY':
        return tenantData.netWorthHistory.length > 0;
      default:
        return tenantData.hasTransactions;
    }
  });

  if (activeLenses.length === 0) {
    logger.info('No active lenses after filtering:', { tenantId });
    return [];
  }

  // 4. Build prompt and call Gemini
  const prompt = buildInsightPrompt(tenantData, activeLenses);
  const rawInsights = await generateInsightContent(prompt);

  if (!Array.isArray(rawInsights) || rawInsights.length === 0) {
    logger.warn('LLM returned no insights:', { tenantId });
    return [];
  }

  // 5. Validate and store
  const batchId = crypto.randomUUID();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const validSeverities = ['POSITIVE', 'INFO', 'WARNING', 'CRITICAL'];
  const insightRecords = rawInsights
    .filter((i) => i.lens && i.title && i.body)
    .map((i) => ({
      tenantId,
      batchId,
      date: today,
      lens: i.lens,
      title: String(i.title).slice(0, 255),
      body: String(i.body),
      severity: validSeverities.includes(i.severity) ? i.severity : 'INFO',
      priority: typeof i.priority === 'number' ? Math.min(Math.max(Math.round(i.priority), 1), 100) : 50,
      dataHash,
      metadata: i.metadata || null,
    }));

  if (insightRecords.length === 0) {
    logger.warn('No valid insights after validation:', { tenantId });
    return [];
  }

  // Delete previous batch and insert new one in a transaction
  await prisma.$transaction([
    prisma.insight.deleteMany({ where: { tenantId } }),
    prisma.insight.createMany({ data: insightRecords }),
  ]);

  logger.info('Insight generation complete:', {
    tenantId,
    batchId,
    insightCount: insightRecords.length,
    lenses: insightRecords.map((i) => i.lens),
  });

  return insightRecords;
}

module.exports = {
  gatherTenantData,
  buildInsightPrompt,
  generateInsights,
};
