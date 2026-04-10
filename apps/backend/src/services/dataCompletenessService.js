const prisma = require('../../prisma/prisma.js');
const logger = require('../utils/logger');

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_DAILY_COVERAGE = 0.80; // 80% of weekdays in a month must have transactions
const MIN_MONTHLY_COMPLETENESS = 10; // At least 10 complete months for annual

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Count weekdays in a date range (Mon-Fri).
 */
function countWeekdays(startDate, endDate) {
  let count = 0;
  const d = new Date(startDate);
  while (d <= endDate) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/**
 * Get the first and last day of a month.
 */
function getMonthRange(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0); // last day of month
  return { start, end };
}

/**
 * Get the months in a quarter (1-indexed).
 * Q1 = [1,2,3], Q2 = [4,5,6], Q3 = [7,8,9], Q4 = [10,11,12]
 */
function getQuarterMonths(quarter) {
  const startMonth = (quarter - 1) * 3 + 1;
  return [startMonth, startMonth + 1, startMonth + 2];
}

/**
 * Get quarter number (1-4) from a month (1-12).
 */
function getQuarterFromMonth(month) {
  return Math.ceil(month / 3);
}

/**
 * Generate a periodKey for each tier.
 */
function getPeriodKey(tier, date) {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;

  switch (tier) {
    case 'MONTHLY':
      return `${year}-${String(month).padStart(2, '0')}`;
    case 'QUARTERLY':
      return `${year}-Q${getQuarterFromMonth(month)}`;
    case 'ANNUAL':
      return `${year}`;
    case 'PORTFOLIO': {
      // ISO week number
      const jan1 = new Date(year, 0, 1);
      const daysSinceJan1 = Math.floor((d - jan1) / 86400000);
      const week = Math.ceil((daysSinceJan1 + jan1.getDay() + 1) / 7);
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    default:
      return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

/**
 * Get the previous period for comparison.
 * Returns { year, month?, quarter? } depending on tier.
 */
function getPreviousPeriod(tier, year, month, quarter) {
  switch (tier) {
    case 'MONTHLY': {
      let prevMonth = month - 1;
      let prevYear = year;
      if (prevMonth <= 0) { prevMonth += 12; prevYear -= 1; }
      return { year: prevYear, month: prevMonth };
    }
    case 'QUARTERLY': {
      let prevQuarter = quarter - 1;
      let prevYear = year;
      if (prevQuarter <= 0) { prevQuarter = 4; prevYear -= 1; }
      return { year: prevYear, quarter: prevQuarter };
    }
    case 'ANNUAL':
      return { year: year - 1 };
    default:
      return null;
  }
}

/**
 * Get the same period from the previous year (for YoY comparisons).
 */
function getYoYPeriod(tier, year, month, quarter) {
  switch (tier) {
    case 'MONTHLY':
      return { year: year - 1, month };
    case 'QUARTERLY':
      return { year: year - 1, quarter };
    default:
      return null;
  }
}

// ─── Core Completeness Checks ────────────────────────────────────────────────

/**
 * Check if a specific month has sufficient transaction data.
 * Returns { complete: boolean, coverage: number, transactionDays: number, expectedDays: number }
 */
async function checkMonthCompleteness(tenantId, year, month) {
  const { start, end } = getMonthRange(year, month);
  const expectedDays = countWeekdays(start, end);

  // Count distinct transaction dates in this month from analytics cache
  const analyticsRows = await prisma.analyticsCacheMonthly.findMany({
    where: { tenantId, year, month },
    select: { credit: true, debit: true },
  });

  // If we have any analytics data for this month, it means transactions exist
  // The analytics cache aggregates by type/group, so having rows means data exists
  const hasData = analyticsRows.length > 0;
  const totalActivity = analyticsRows.reduce((sum, r) => {
    return sum + Math.abs(Number(r.credit || 0)) + Math.abs(Number(r.debit || 0));
  }, 0);

  // For completeness, also check actual transaction count in the month
  const txCount = await prisma.transaction.count({
    where: {
      tenantId,
      date: { gte: start, lte: end },
    },
  });

  // Count distinct transaction days
  const distinctDays = await prisma.transaction.groupBy({
    by: ['date'],
    where: {
      tenantId,
      date: { gte: start, lte: end },
    },
  });

  const transactionDays = distinctDays.length;
  const coverage = expectedDays > 0 ? transactionDays / expectedDays : 0;

  return {
    complete: coverage >= MIN_DAILY_COVERAGE && hasData,
    coverage: Math.round(coverage * 100) / 100,
    transactionDays,
    expectedDays,
    totalActivity,
  };
}

/**
 * Check completeness for a quarter.
 * All 3 months must individually pass monthly completeness.
 */
async function checkQuarterCompleteness(tenantId, year, quarter) {
  const months = getQuarterMonths(quarter);
  const monthChecks = await Promise.all(
    months.map((m) => checkMonthCompleteness(tenantId, year, m))
  );

  const allComplete = monthChecks.every((c) => c.complete);
  const avgCoverage = monthChecks.reduce((sum, c) => sum + c.coverage, 0) / 3;

  return {
    complete: allComplete,
    monthlyResults: months.map((m, i) => ({ month: m, ...monthChecks[i] })),
    averageCoverage: Math.round(avgCoverage * 100) / 100,
  };
}

/**
 * Check completeness for a full year.
 * At least MIN_MONTHLY_COMPLETENESS months (default 10) must pass monthly completeness.
 */
async function checkYearCompleteness(tenantId, year) {
  const monthChecks = await Promise.all(
    Array.from({ length: 12 }, (_, i) => checkMonthCompleteness(tenantId, year, i + 1))
  );

  const completeMonths = monthChecks.filter((c) => c.complete).length;
  const avgCoverage = monthChecks.reduce((sum, c) => sum + c.coverage, 0) / 12;

  return {
    complete: completeMonths >= MIN_MONTHLY_COMPLETENESS,
    completeMonths,
    monthlyResults: monthChecks.map((c, i) => ({ month: i + 1, ...c })),
    averageCoverage: Math.round(avgCoverage * 100) / 100,
  };
}

// ─── Tier-Specific Completeness Gates ────────────────────────────────────────

/**
 * Check if Monthly tier can run for a given month.
 * Month must be closed (in the past) and pass completeness.
 */
async function checkMonthlyTierCompleteness(tenantId, year, month) {
  const now = new Date();
  const { end } = getMonthRange(year, month);

  // Month must be closed
  if (now <= end) {
    return { complete: false, reason: 'Month is not yet closed', monthClosed: false };
  }

  const monthCheck = await checkMonthCompleteness(tenantId, year, month);

  // Check comparison periods
  const prevPeriod = getPreviousPeriod('MONTHLY', year, month);
  const yoyPeriod = getYoYPeriod('MONTHLY', year, month);

  const prevCheck = prevPeriod
    ? await checkMonthCompleteness(tenantId, prevPeriod.year, prevPeriod.month)
    : null;
  const yoyCheck = yoyPeriod
    ? await checkMonthCompleteness(tenantId, yoyPeriod.year, yoyPeriod.month)
    : null;

  return {
    complete: monthCheck.complete,
    monthClosed: true,
    primary: monthCheck,
    comparison: {
      previousMonth: prevCheck ? { ...prevCheck, year: prevPeriod.year, month: prevPeriod.month } : null,
      sameMonthLastYear: yoyCheck ? { ...yoyCheck, year: yoyPeriod.year, month: yoyPeriod.month } : null,
    },
  };
}

/**
 * Check if Quarterly tier can run for a given quarter.
 * Quarter must be closed and all 3 months must pass completeness.
 */
async function checkQuarterlyTierCompleteness(tenantId, year, quarter) {
  const now = new Date();
  const lastMonthOfQuarter = quarter * 3;
  const { end } = getMonthRange(year, lastMonthOfQuarter);

  // Quarter must be closed
  if (now <= end) {
    return { complete: false, reason: 'Quarter is not yet closed', quarterClosed: false };
  }

  const quarterCheck = await checkQuarterCompleteness(tenantId, year, quarter);

  // Check comparison periods
  const prevPeriod = getPreviousPeriod('QUARTERLY', year, null, quarter);
  const yoyPeriod = getYoYPeriod('QUARTERLY', year, null, quarter);

  const prevCheck = prevPeriod
    ? await checkQuarterCompleteness(tenantId, prevPeriod.year, prevPeriod.quarter)
    : null;
  const yoyCheck = yoyPeriod
    ? await checkQuarterCompleteness(tenantId, yoyPeriod.year, yoyPeriod.quarter)
    : null;

  return {
    complete: quarterCheck.complete,
    quarterClosed: true,
    primary: quarterCheck,
    comparison: {
      previousQuarter: prevCheck ? { ...prevCheck, year: prevPeriod.year, quarter: prevPeriod.quarter } : null,
      sameQuarterLastYear: yoyCheck ? { ...yoyCheck, year: yoyPeriod.year, quarter: yoyPeriod.quarter } : null,
    },
  };
}

/**
 * Check if Annual tier can run for a given year.
 * Year must be closed and pass completeness.
 * At least 1 prior complete year must exist for trend comparison.
 */
async function checkAnnualTierCompleteness(tenantId, year) {
  const now = new Date();

  // Year must be closed
  if (now.getFullYear() <= year) {
    return { complete: false, reason: 'Year is not yet closed', yearClosed: false };
  }

  const yearCheck = await checkYearCompleteness(tenantId, year);

  // Check prior years for trend comparison
  const prevYear1 = await checkYearCompleteness(tenantId, year - 1);
  const prevYear2 = await checkYearCompleteness(tenantId, year - 2);

  return {
    complete: yearCheck.complete,
    yearClosed: true,
    primary: yearCheck,
    comparison: {
      previousYear: { ...prevYear1, year: year - 1 },
      twoYearsAgo: prevYear2.completeMonths > 0 ? { ...prevYear2, year: year - 2 } : null,
    },
  };
}

/**
 * Check if Portfolio Intelligence tier can run.
 * Requires at least 1 priced holding with SecurityMaster data.
 */
async function checkPortfolioTierCompleteness(tenantId) {
  const holdingsWithFundamentals = await prisma.portfolioItem.count({
    where: {
      tenantId,
      quantity: { gt: 0 },
      ticker: { not: null },
      category: {
        type: 'Investments',
      },
    },
  });

  // Check if any SecurityMaster data exists for tenant's holdings
  const holdingsWithSecurityMaster = await prisma.portfolioItem.findMany({
    where: {
      tenantId,
      quantity: { gt: 0 },
      ticker: { not: null },
      category: { type: 'Investments' },
    },
    select: { ticker: true },
  });

  const tickers = holdingsWithSecurityMaster.map((h) => h.ticker).filter(Boolean);
  const securityMasterCount = tickers.length > 0
    ? await prisma.securityMaster.count({
        where: { symbol: { in: tickers } },
      })
    : 0;

  return {
    complete: securityMasterCount > 0,
    holdingsCount: holdingsWithFundamentals,
    securityMasterCount,
    tickers,
  };
}

// ─── Unified Gate ────────────────────────────────────────────────────────────

/**
 * Run the completeness check for a specific tier.
 * Returns { canRun, details, comparisonAvailable }.
 */
async function checkTierCompleteness(tenantId, tier, params = {}) {
  const { year, month, quarter, force } = params;

  // Force override bypasses completeness checks
  if (force) {
    logger.info('Force override: skipping completeness check', { tenantId, tier });
    return { canRun: true, forced: true, details: null };
  }

  try {
    switch (tier) {
      case 'MONTHLY': {
        if (!year || !month) throw new Error('year and month required for MONTHLY tier');
        const result = await checkMonthlyTierCompleteness(tenantId, year, month);
        return {
          canRun: result.complete,
          details: result,
          comparisonAvailable: {
            previousMonth: result.comparison?.previousMonth?.complete || false,
            sameMonthLastYear: result.comparison?.sameMonthLastYear?.complete || false,
          },
        };
      }

      case 'QUARTERLY': {
        if (!year || !quarter) throw new Error('year and quarter required for QUARTERLY tier');
        const result = await checkQuarterlyTierCompleteness(tenantId, year, quarter);
        return {
          canRun: result.complete,
          details: result,
          comparisonAvailable: {
            previousQuarter: result.comparison?.previousQuarter?.complete || false,
            sameQuarterLastYear: result.comparison?.sameQuarterLastYear?.complete || false,
          },
        };
      }

      case 'ANNUAL': {
        if (!year) throw new Error('year required for ANNUAL tier');
        const result = await checkAnnualTierCompleteness(tenantId, year);
        return {
          canRun: result.complete,
          details: result,
          comparisonAvailable: {
            previousYear: result.comparison?.previousYear?.complete || false,
            twoYearsAgo: result.comparison?.twoYearsAgo?.complete || false,
          },
        };
      }

      case 'PORTFOLIO': {
        const result = await checkPortfolioTierCompleteness(tenantId);
        return {
          canRun: result.complete,
          details: result,
          comparisonAvailable: true,
        };
      }

      default:
        throw new Error(`Unknown tier: ${tier}`);
    }
  } catch (error) {
    logger.error('Completeness check failed:', { tenantId, tier, error: error.message });
    return { canRun: false, error: error.message };
  }
}

module.exports = {
  checkTierCompleteness,
  checkMonthCompleteness,
  checkQuarterCompleteness,
  checkYearCompleteness,
  checkPortfolioTierCompleteness,
  getPeriodKey,
  getPreviousPeriod,
  getYoYPeriod,
  getQuarterMonths,
  getQuarterFromMonth,
  countWeekdays,
};
