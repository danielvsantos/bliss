import prisma from '../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../utils/cors.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { withAuth } from '../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.analytics(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  // Handle CORS
  if (cors(req, res)) return;

  try {
    switch (req.method) {
      case 'GET':
        await handleGet(req, res);
        return;
      case 'POST':
        await handlePost(req, res);
        return;
      case 'PUT':
        handlePut(req, res);
        return;
      case 'DELETE':
        handleDelete(req, res);
        return;
      default:
        res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
        res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
        return;
    }
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
    currency = 'USD',
    countries = [],
    view = 'year',
    years = [],
    startMonth,
    endMonth,
    startQuarter,
    endQuarter,
    types = [],
    groups = []
  } = req.query;

  const selectedCountries = typeof countries === 'string' ? [countries] : countries;
  const yearArray = typeof years === 'string' ? [parseInt(years)] : years.map(Number);
  const selectedTypes = typeof types === 'string' ? [types] : types;
  const selectedGroups = typeof groups === 'string' ? [groups] : groups;

  const filters = {
    currency,
    tenantId: req.user.tenantId,
    ...(selectedCountries.length && { country: { in: selectedCountries } }),
    ...(selectedTypes.length && { type: { in: selectedTypes } }),
    ...(selectedGroups.length && { group: { in: selectedGroups } }),
  };

  if (view === 'year') {
    filters.year = { in: yearArray };
  } else if (view === 'month') {
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
  } else if (view === 'quarter') {
    const [startYear, startQ] = startQuarter.split('-Q').map(Number);
    const [endYear, endQ] = endQuarter.split('-Q').map(Number);

    filters.OR = [];
    for (let year = startYear; year <= endYear; year++) {
      const minQ = year === startYear ? startQ : 1;
      const maxQ = year === endYear ? endQ : 4;
      for (let q = minQ; q <= maxQ; q++) {
        const startMonth = (q - 1) * 3 + 1;
        const endMonth = startMonth + 2;
        filters.OR.push({
          year,
          month: { gte: startMonth, lte: endMonth },
        });
      }
    }
  }

  const results = await prisma.analyticsCacheMonthly.findMany({
    where: filters,
  });

  const timeGrouped = {};

  // First, group by time period (year, quarter, month)
  for (const row of results) {
    let key;
    if (view === 'year') {
      key = row.year.toString();
    } else if (view === 'quarter') {
      const quarter = `Q${Math.ceil(row.month / 3)}`;
      key = `${row.year}-${quarter}`;
    } else if (view === 'month') {
      key = `${row.year}-${String(row.month).padStart(2, '0')}`;
    }

    if (!timeGrouped[key]) {
      timeGrouped[key] = [];
    }
    timeGrouped[key].push(row);
  }
  
  // Now, for each time period, create the nested structure
  const finalResponse = {};
  for (const timeKey in timeGrouped) {
    const periodData = timeGrouped[timeKey];
    const nestedStructure = {};

    for (const row of periodData) {
      const { type, group, credit, debit, balance } = row;

      if (!nestedStructure[type]) {
        nestedStructure[type] = {};
      }
      if (!nestedStructure[type][group]) {
        nestedStructure[type][group] = {
          credit: 0,
          debit: 0,
          balance: 0,
        };
      }

      nestedStructure[type][group].credit += credit.toNumber();
      nestedStructure[type][group].debit += debit.toNumber();
      nestedStructure[type][group].balance += balance.toNumber();
    }
    finalResponse[timeKey] = nestedStructure;
  }

  res.status(StatusCodes.OK).json({ currency, view, data: finalResponse });
}

function handlePost(req, res) {
  res.status(StatusCodes.NOT_IMPLEMENTED).json({ error: "POST not implemented" });
}

function handlePut(req, res) {
  res.status(StatusCodes.NOT_IMPLEMENTED).json({ error: "PUT not implemented" });
}

function handleDelete(req, res) {
  res.status(StatusCodes.NOT_IMPLEMENTED).json({ error: "DELETE not implemented" });
}
