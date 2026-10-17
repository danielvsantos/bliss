import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { withAuth } from '../../../utils/withAuth.js';
import { batchFetchRates } from '../../../utils/currencyConversion.js';
import { produceEvent } from '../../../utils/produceEvent.js';
import { eventOrigin } from '../../../utils/eventOrigin.js';

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

const DAY_MS = 86_400_000;
// Weekly sampling covers ranges up to ~5 years (≈ 262 sample dates), so "All"
// on a typical portfolio is weekly rather than month-ends (#137).
const WEEKLY_MAX_DAYS = 5 * 366;
// Holdings whose buy/sell days become extra sample points (#137). Cash items
// are left out on purpose: every bank transaction would become a sample date.
const TRADED_PROCESSING_HINTS = ['API_STOCK', 'API_CRYPTO', 'API_FUND'];
// Cap on trade days added to a sampled response; above it only each holding's
// first/last valuation dates are added, keeping the row count bounded (P6009).
const MAX_TRADE_SAMPLE_DATES = 400;

/**
 * Determines the appropriate data resolution for a given date range.
 * Keeps Prisma query row counts bounded regardless of portfolio size:
 *   ≤ 90 days  → daily   (all dates)
 *   ≤ ~5 years → weekly  (≤ ~262 dates)
 *   longer     → monthly (~N months)
 */
function getAutoResolution(fromDate, toDate) {
  const days = (toDate - fromDate) / DAY_MS;
  if (days <= 90)  return 'daily';
  if (days <= WEEKLY_MAX_DAYS) return 'weekly';
  return 'monthly';
}

/** UTC midnight of a date (history rows are keyed by UTC day). */
function utcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Builds a list of representative dates (Saturdays for weekly, last calendar
 * day of each month for monthly) within [fromDate, toDate], always including
 * the range's first and last day so the series starts on the first valuation
 * and ends on the latest one.
 * Returns null for 'daily' (no restriction needed).
 *
 * Because portfolioValueHistory is populated daily by the valuation worker,
 * every weekend Saturday and every month-end date will have a record.
 */
function buildSampleDates(fromDate, toDate, resolution) {
  if (resolution === 'daily') return null;

  const dates = [utcDay(fromDate)];

  if (resolution === 'weekly') {
    // Advance to the first Saturday on or after fromDate (using UTC to match valuation worker)
    const d = utcDay(fromDate);
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
  }

  // Always include toDate so the most recent value is represented
  dates.push(utcDay(toDate));

  return dates;
}

/**
 * Days on which a holding in scope starts, stops or trades within the range
 * (#137): each asset's first and last valuation, plus the trade days of
 * stock / crypto / fund holdings, each with the day before (#147). Sampling
 * these keeps a buy on day D a rise between D−1 and D (never back-dated to
 * the previous month-end or week) and a sell-off a drop on the sell day.
 */
async function fetchHoldingEventDates({ tenantId, assetWhere, fromDate, toDate }) {
  const range = { gte: utcDay(fromDate), lte: toDate };

  const bounds = await prisma.portfolioValueHistory.groupBy({
    by: ['assetId'],
    where: { asset: assetWhere, date: range },
    _min: { date: true },
    _max: { date: true },
  });

  const { category, ...itemWhere } = assetWhere;
  const trades = await prisma.transaction.findMany({
    where: {
      tenantId,
      transaction_date: range,
      portfolioItem: {
        ...itemWhere,
        category: { ...(category || {}), processingHint: { in: TRADED_PROCESSING_HINTS } },
      },
    },
    select: { transaction_date: true },
    distinct: ['transaction_date'],
    orderBy: { transaction_date: 'asc' },
    take: MAX_TRADE_SAMPLE_DATES + 1,
  });

  const dates = [];
  for (const b of bounds) {
    if (b._min?.date) dates.push(utcDay(b._min.date));
    if (b._max?.date) dates.push(utcDay(b._max.date));
  }
  if (trades.length <= MAX_TRADE_SAMPLE_DATES) {
    // Each trade day D also samples D−1 (#147), so a mid-week buy rises (and
    // a sell-off drops) within one day on the linear chart instead of ramping
    // from the previous weekly sample. Bounded: ≤ 2 × MAX_TRADE_SAMPLE_DATES.
    const firstDay = utcDay(fromDate);
    for (const t of trades) {
      const day = utcDay(t.transaction_date);
      dates.push(day);
      const dayBefore = new Date(day.getTime() - DAY_MS);
      if (dayBefore >= firstDay) dates.push(dayBefore);
    }
  }
  return dates;
}

/** Merges date lists, dropping duplicate days, sorted ascending. */
function mergeSampleDates(...lists) {
  const byDay = new Map();
  for (const list of lists) {
    for (const d of list) byDay.set(d.toISOString().split('T')[0], d);
  }
  return [...byDay.values()].sort((a, b) => a - b);
}

/**
 * Parses the optional holding scope (#131) from the query string.
 * Returns `{ filter }` (a PortfolioItem where fragment, empty when absent)
 * or `{ error }` for a 400.
 */
function parseHoldingScope(query) {
  const rawSymbol = typeof query.symbol === 'string' ? query.symbol.trim() : undefined;
  const rawItemId = typeof query.itemId === 'string' ? query.itemId.trim() : undefined;
  const hasSymbol = rawSymbol !== undefined && rawSymbol !== '';
  const hasItemId = rawItemId !== undefined && rawItemId !== '';

  if (hasSymbol && hasItemId) {
    return { error: 'Pass either "symbol" or "itemId", not both.' };
  }
  if (hasSymbol) {
    if (rawSymbol.length > 50) return { error: '"symbol" must be at most 50 characters.' };
    return { filter: { symbol: rawSymbol } };
  }
  if (hasItemId) {
    const id = Number(rawItemId);
    if (!/^\d+$/.test(rawItemId) || !Number.isSafeInteger(id) || id <= 0) {
      return { error: '"itemId" must be a positive integer.' };
    }
    return { filter: { id } };
  }
  return { filter: {} };
}

async function handleGet(req, res) {
  const { from, to, type, group, resolution: resolutionParam, accountId } = req.query;
  const user = req.user;
  const tenantId = user.tenantId;
  // Optional account scope: when provided, history is limited to portfolio items
  // belonging to that account. Absent = tenant-wide aggregated view.
  const accountFilter = accountId ? { accountId: parseInt(accountId, 10) } : {};

  // Optional holding scope (#131): `symbol` sums every item with that symbol
  // (across accounts unless `accountId` narrows it); `itemId` is a single item
  // (manual / symbol-less assets). Mutually exclusive. Both stay under tenantId.
  const holding = parseHoldingScope(req.query);
  if (holding.error) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: holding.error });
    return;
  }
  const assetScope = { tenantId, ...accountFilter, ...holding.filter };

  // --- Staleness check: trigger background revaluation if history is outdated ---
  // This ensures portfolio history stays current even for self-hosters without
  // reliable nightly cron infrastructure. The response returns existing data
  // immediately; the next fetch will have fresh data.
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const latestRecord = await prisma.portfolioValueHistory.findFirst({
      where: { asset: assetScope },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

    // Only fire the staleness event when we have history AND it's outdated.
    // If latestRecord is null, either the user has no portfolio items at all
    // (nothing to revalue) or a rebuild is in progress (the valuation engine
    // deletes all history before recreating it). In both cases, firing another
    // event would be wasteful or trigger an infinite rebuild loop.
    if (latestRecord) {
      const latestDateStr = latestRecord.date.toISOString().split('T')[0];
      if (latestDateStr < todayStr) {
        // Fire-and-forget: trigger revaluation via backend event
        produceEvent({
          ...eventOrigin(req),
          type: 'PORTFOLIO_STALE_REVALUATION',
          tenantId,
        }).catch(() => {}); // Swallow errors — this is non-critical
      }
    }
  } catch (err) {
    // Non-critical: don't fail the GET request over a staleness check
    console.warn('Failed staleness check for portfolio history:', err.message);
  }

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
      where: { asset: assetScope },
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    fromDate = earliest ? earliest.date : new Date(toDate.getTime() - 365 * DAY_MS);
  }

  // Determine effective resolution: explicit param > auto-detect from date range
  const effectiveResolution = (resolutionParam && ['daily', 'weekly', 'monthly'].includes(resolutionParam))
    ? resolutionParam
    : getAutoResolution(fromDate, toDate);

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

    const assetWhere = {
      ...assetScope,
      ...(categoryFilter && { category: categoryFilter }),
    };

    let sampleDates = buildSampleDates(fromDate, toDate, effectiveResolution);
    if (sampleDates) {
      const eventDates = await fetchHoldingEventDates({ tenantId, assetWhere, fromDate, toDate });
      sampleDates = mergeSampleDates(sampleDates, eventDates);
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
        asset: assetWhere,
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
          // Convert each category-type block (Investments, Asset, Debt, etc.) in-place
          // so consumers receive consistently-converted values without re-converting.
          for (const key of Object.keys(entry)) {
            const block = entry[key];
            if (block && typeof block === 'object' && 'total' in block && 'groups' in block) {
              block.total = parseFloat(rate.times(block.total).toFixed(2));
              for (const g of Object.keys(block.groups)) {
                block.groups[g] = parseFloat(rate.times(block.groups[g]).toFixed(2));
              }
            }
          }
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
