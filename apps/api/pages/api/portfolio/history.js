import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { withAuth } from '../../../utils/withAuth.js';
import { batchFetchRates } from '../../../utils/currencyConversion.js';

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  try {
    switch (req.method) {
      case 'GET':
        await handleGet(req, res);
        break;
      default:
        res.setHeader('Allow', ['GET']);
        res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
        break;
    }
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

// --- Resolution helpers ---

/**
 * Determines the appropriate data resolution for a given date range.
 * Keeps Prisma query row counts bounded regardless of portfolio size:
 *   ≤ 90 days  → daily   (all dates)
 *   ≤ 365 days → weekly  (~52 dates)
 *   > 365 days → monthly (~N months)
 */
function getAutoResolution(fromDate, toDate) {
  const days = (toDate - fromDate) / 86_400_000;
  if (days <= 90)  return 'daily';
  if (days <= 365) return 'weekly';
  return 'monthly';
}

/**
 * Builds a list of representative dates (Saturdays for weekly, last calendar
 * day of each month for monthly) within [fromDate, toDate].
 * Returns null for 'daily' (no restriction needed).
 *
 * Because portfolioValueHistory is populated daily by the valuation worker,
 * every weekend Saturday and every month-end date will have a record.
 */
function buildSampleDates(fromDate, toDate, resolution) {
  if (resolution === 'daily') return null;

  const dates = [];

  if (resolution === 'weekly') {
    // Advance to the first Saturday on or after fromDate (using UTC to match valuation worker)
    const d = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
    const daysUntilSat = (6 - d.getUTCDay() + 7) % 7;
    d.setUTCDate(d.getUTCDate() + daysUntilSat);
    while (d <= toDate) {
      dates.push(new Date(d));
      d.setUTCDate(d.getUTCDate() + 7);
    }
  } else {
    // Monthly: last calendar day of each month within the range (UTC to match valuation worker)
    const d = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
    while (d <= toDate) {
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      if (lastDay <= toDate) dates.push(new Date(lastDay));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    // Always include toDate so the most recent value is represented
    const toStr = toDate.toISOString().split('T')[0];
    if (!dates.some(x => x.toISOString().split('T')[0] === toStr)) {
      dates.push(new Date(toDate));
    }
  }

  return dates;
}

async function handleGet(req, res) {
  const { from, to, type, group, resolution: resolutionParam } = req.query;
  const user = req.user;
  const tenantId = user.tenantId;

  if (from && isNaN(new Date(from).getTime())) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid "from" date format.' });
    return;
  }
  if (to && isNaN(new Date(to).getTime())) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid "to" date format.' });
    return;
  }

  const toDate = to ? new Date(to) : new Date();

  // When no `from` is provided, find the earliest history record for this tenant
  // so "All" timeframe returns the full dataset. The resolution system (weekly/monthly
  // sampling) keeps row counts bounded regardless of date range.
  let fromDate;
  if (from) {
    fromDate = new Date(from);
  } else {
    const earliest = await prisma.portfolioValueHistory.findFirst({
      where: { asset: { tenantId } },
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    fromDate = earliest ? earliest.date : new Date(toDate.getTime() - 365 * 86_400_000);
  }

  // Determine effective resolution: explicit param > auto-detect from date range
  const effectiveResolution = (resolutionParam && ['daily', 'weekly', 'monthly'].includes(resolutionParam))
    ? resolutionParam
    : getAutoResolution(fromDate, toDate);

  const sampleDates = buildSampleDates(fromDate, toDate, effectiveResolution);

  try {
    // Fetch tenant's portfolio currency
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { portfolioCurrency: true },
    });
    const portfolioCurrency = tenant?.portfolioCurrency || 'USD';

    // Build category filter (applied to the asset relation, not directly on the history row)
    let categoryFilter = undefined;
    if (type || group) {
      categoryFilter = {};
      if (type)  categoryFilter.type  = { in: type.split(',') };
      if (group) categoryFilter.group = { in: group.split(',') };
    }

    // Use exact sample dates for weekly/monthly, a range for daily.
    // This is the key change that prevents P6009: instead of returning every
    // row for the full date range, we only return one row per period per asset.
    const dateFilter = sampleDates
      ? { in: sampleDates }
      : { gte: fromDate, lte: toDate };

    const history = await prisma.portfolioValueHistory.groupBy({
      by: ['date', 'assetId'],
      where: {
        asset: {
          tenantId,
          ...(categoryFilter && { category: categoryFilter }),
        },
        date: dateFilter,
      },
      _sum: {
        valueInUSD: true,
      },
    });

    // Fetch asset details to group by category type
    const assetIds = [...new Set(history.map(h => h.assetId))];
    const assets = await prisma.portfolioItem.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, category: { select: { type: true, group: true } } },
    });
    const assetMap = new Map(assets.map(a => [a.id, a]));

    // Aggregate results in memory by date and category
    const aggregated = history.reduce((acc, current) => {
      const date = current.date.toISOString().split('T')[0];
      const asset = assetMap.get(current.assetId);

      if (!asset) return acc;

      if (!acc[date]) {
        acc[date] = { date, totalUSD: 0 };
      }

      const value = parseFloat(current._sum.valueInUSD);
      const { type: assetType, group: assetGroup } = asset.category;

      if (!acc[date][assetType]) {
        acc[date][assetType] = { total: 0, groups: {} };
      }
      acc[date][assetType].total += value;
      acc[date][assetType].groups[assetGroup] = (acc[date][assetType].groups[assetGroup] || 0) + value;
      acc[date].totalUSD += value;

      return acc;
    }, {});

    const formattedHistory = Object.values(aggregated).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Convert to portfolio currency if not USD
    if (portfolioCurrency !== 'USD' && formattedHistory.length > 0) {
      const dateStrings = formattedHistory.map(h => h.date);
      const rateMap = await batchFetchRates('USD', portfolioCurrency, dateStrings);

      for (const entry of formattedHistory) {
        const rate = rateMap.get(entry.date);
        if (rate) {
          entry.totalPortfolioCurrency = parseFloat(rate.times(entry.totalUSD).toFixed(2));
        } else {
          entry.totalPortfolioCurrency = null;
        }
      }
    }

    res.status(StatusCodes.OK).json({
      portfolioCurrency,
      resolution: effectiveResolution,
      history: formattedHistory,
    });
  } catch (error) {
    console.error('Failed to fetch portfolio history:', error);
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to fetch portfolio history',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}
