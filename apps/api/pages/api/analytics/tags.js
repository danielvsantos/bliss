import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.analytics(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }

    await handleGet(req, res);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

async function handleGet(req, res) {
  const {
    tagIds,
    'tagIds[]': tagIdsArray,
    currency = 'USD',
    view = 'month',
    years = [],
    startMonth,
    endMonth,
    startQuarter,
    endQuarter,
  } = req.query;

  // Normalize tagIds from query params (supports both tagIds[]=1&tagIds[]=2 and tagIds=1)
  // Next.js returns a string for single values, array for multiple — always coerce to array
  const rawTagIdsSource = tagIdsArray || tagIds;
  const rawTagIds = Array.isArray(rawTagIdsSource) ? rawTagIdsSource : rawTagIdsSource ? [rawTagIdsSource] : [];
  const normalizedTagIds = rawTagIds
    .map(id => parseInt(id, 10))
    .filter(id => !isNaN(id));

  if (normalizedTagIds.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'At least one tagId is required' });
  }

  const yearArray = typeof years === 'string' ? [parseInt(years)] : (Array.isArray(years) ? years.map(Number) : []);

  const filters = {
    currency,
    tenantId: req.user.tenantId,
    tagId: { in: normalizedTagIds },
  };

  if (view === 'year') {
    if (yearArray.length > 0) {
      filters.year = { in: yearArray };
    }
  } else if (view === 'month') {
    // startMonth/endMonth are optional — when omitted, return all months
    if (startMonth && endMonth) {
      const [startYear, startMonthNum] = startMonth.split('-').map(Number);
      const [endYear, endMonthNum] = endMonth.split('-').map(Number);

      filters.OR = [];
      for (let year = startYear; year <= endYear; year++) {
        const minMonth = year === startYear ? startMonthNum : 1;
        const maxMonth = year === endYear ? endMonthNum : 12;
        filters.OR.push({
          year,
          month: { gte: minMonth, lte: maxMonth },
        });
      }
    }
  } else if (view === 'quarter') {
    if (!startQuarter || !endQuarter) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'startQuarter and endQuarter are required for quarter view' });
    }
    const [startYear, startQ] = startQuarter.split('-Q').map(Number);
    const [endYear, endQ] = endQuarter.split('-Q').map(Number);

    filters.OR = [];
    for (let year = startYear; year <= endYear; year++) {
      const minQ = year === startYear ? startQ : 1;
      const maxQ = year === endYear ? endQ : 4;
      for (let q = minQ; q <= maxQ; q++) {
        const qStartMonth = (q - 1) * 3 + 1;
        const qEndMonth = qStartMonth + 2;
        filters.OR.push({
          year,
          month: { gte: qStartMonth, lte: qEndMonth },
        });
      }
    }
  }

  const results = await prisma.tagAnalyticsCacheMonthly.findMany({
    where: filters,
  });

  // Group by tagId → time → type → group → categoryName
  const tagGrouped = {};

  for (const row of results) {
    const tagKey = row.tagId.toString();
    if (!tagGrouped[tagKey]) tagGrouped[tagKey] = {};

    let timeKey;
    if (view === 'year') {
      timeKey = row.year.toString();
    } else if (view === 'quarter') {
      const quarter = `Q${Math.ceil(row.month / 3)}`;
      timeKey = `${row.year}-${quarter}`;
    } else {
      timeKey = `${row.year}-${String(row.month).padStart(2, '0')}`;
    }

    if (!tagGrouped[tagKey][timeKey]) tagGrouped[tagKey][timeKey] = {};

    const { type, group, categoryName, credit, debit, balance } = row;

    if (!tagGrouped[tagKey][timeKey][type]) {
      tagGrouped[tagKey][timeKey][type] = {};
    }
    if (!tagGrouped[tagKey][timeKey][type][group]) {
      tagGrouped[tagKey][timeKey][type][group] = {};
    }
    if (!tagGrouped[tagKey][timeKey][type][group][categoryName]) {
      tagGrouped[tagKey][timeKey][type][group][categoryName] = { credit: 0, debit: 0, balance: 0 };
    }

    tagGrouped[tagKey][timeKey][type][group][categoryName].credit += credit.toNumber();
    tagGrouped[tagKey][timeKey][type][group][categoryName].debit += debit.toNumber();
    tagGrouped[tagKey][timeKey][type][group][categoryName].balance += balance.toNumber();
  }

  res.status(StatusCodes.OK).json({ currency, view, tags: tagGrouped });
}
