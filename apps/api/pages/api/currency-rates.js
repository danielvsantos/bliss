import prisma from '../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../utils/cors.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { withAuth } from '../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {

  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.currencyrates(req, res, (result) => {
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
        break;
      case 'POST':
        await handlePost(req, res);
        break;
      case 'PUT':
        await handlePut(req, res);
        break;
      case 'DELETE':
        await handleDelete(req, res);
        break;
      default:
        res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
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

// Helper function to validate currencies for a tenant
async function validateCurrencies(currencyFrom, currencyTo, tenantId) {
  const [fromCurrency, toCurrency] = await Promise.all([
    prisma.tenantCurrency.findFirst({
      where: {
        tenantId,
        currencyId: currencyFrom
      },
      include: {
        currency: true
      }
    }),
    prisma.tenantCurrency.findFirst({
      where: {
        tenantId,
        currencyId: currencyTo
      },
      include: {
        currency: true
      }
    })
  ]);

  const errors = [];
  if (!fromCurrency) {
    errors.push(`Currency '${currencyFrom}' is not available for this tenant`);
  }
  if (!toCurrency) {
    errors.push(`Currency '${currencyTo}' is not available for this tenant`);
  }

  return {
    isValid: errors.length === 0,
    errors,
    fromCurrency,
    toCurrency
  };
}

async function handleGet(req, res) {
  const tenantId = req.user.tenantId;
  const { id, year, month, day, currencyFrom, currencyTo } = req.query;

  if (id) {
    const currencyRateId = parseInt(id, 10);
    if (isNaN(currencyRateId)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid currency rate ID' });
      return;
    }

    const currencyRate = await prisma.currencyRate.findUnique({
      where: { id: currencyRateId }
    });

    if (!currencyRate) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Currency Rate not found' });
      return;
    }

    // Validate tenant has access to both currencies
    const { isValid, errors } = await validateCurrencies(
      currencyRate.currencyFrom,
      currencyRate.currencyTo,
      tenantId
    );

    if (!isValid) {
      res.status(StatusCodes.FORBIDDEN).json({
        error: 'Access denied',
        details: errors
      });
      return;
    }

    res.status(StatusCodes.OK).json(currencyRate);
    return;
  }

  // Build filters
  const filters = {};
  if (year) filters.year = parseInt(year, 10);
  if (month) filters.month = parseInt(month, 10);
  if (day) filters.day = parseInt(day, 10);
  
  // If specific currencies are requested, validate tenant access
  if (currencyFrom || currencyTo) {
    const { isValid, errors } = await validateCurrencies(
      currencyFrom?.toUpperCase(),
      currencyTo?.toUpperCase(),
      tenantId
    );

    if (!isValid) {
      res.status(StatusCodes.FORBIDDEN).json({
        error: 'Access denied',
        details: errors
      });
      return;
    }

    if (currencyFrom) filters.currencyFrom = currencyFrom.toUpperCase();
    if (currencyTo) filters.currencyTo = currencyTo.toUpperCase();
  } else {
    // If no specific currencies requested, get all rates for tenant's currencies
    const tenantCurrencies = await prisma.tenantCurrency.findMany({
      where: { tenantId },
      select: { currencyId: true }
    });

    const currencyIds = tenantCurrencies.map(tc => tc.currencyId);
    filters.OR = [
      { currencyFrom: { in: currencyIds } },
      { currencyTo: { in: currencyIds } }
    ];
  }

  const results = await prisma.currencyRate.findMany({
    where: filters,
    orderBy: [
      { year: 'desc' },
      { month: 'desc' },
      { day: 'desc' }
    ],
  });

  res.status(StatusCodes.OK).json(results);
  return;
}

async function handlePost(req, res) {
  const tenantId = req.user.tenantId;
  try {
    const { year, month, day, currencyFrom, currencyTo, value, provider } = req.body;

    if (!year || !month || !day || !currencyFrom || !currencyTo || !value) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing required fields' });
      return;
    }

    // Validate currencies
    const { isValid, errors, fromCurrency, toCurrency } = await validateCurrencies(
      currencyFrom.toUpperCase(),
      currencyTo.toUpperCase(),
      tenantId
    );

    if (!isValid) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Invalid currencies',
        details: errors
      });
      return;
    }

    // Prevent same currency conversion
    if (currencyFrom.toUpperCase() === currencyTo.toUpperCase()) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Invalid currency pair',
        details: 'Cannot create conversion rate between the same currency'
      });
      return;
    }

    const newCurrencyRate = await prisma.currencyRate.upsert({
      where: {
        year_month_day_currencyFrom_currencyTo: {
          year: parseInt(year, 10),
          month: parseInt(month, 10),
          day: parseInt(day, 10),
          currencyFrom: currencyFrom.toUpperCase(),
          currencyTo: currencyTo.toUpperCase(),
        },
      },
      update: {
        value: value,
        provider,
        updatedAt: new Date(),
      },
      create: {
        year: parseInt(year, 10),
        month: parseInt(month, 10),
        day: parseInt(day, 10),
        currencyFrom: currencyFrom.toUpperCase(),
        currencyTo: currencyTo.toUpperCase(),
        value: value,
        provider,
      }
    });

    res.status(StatusCodes.CREATED).json(newCurrencyRate);
    return;
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Creation Failed',
      details: error.message,
    });
  }
}

async function handlePut(req, res) {
  const tenantId = req.user.tenantId;
  try {
    const { id } = req.query;
    const currencyRateId = parseInt(id, 10);
    if (isNaN(currencyRateId)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid currency rate ID' });
      return;
    }

    const { year, month, day, currencyFrom, currencyTo, value, provider } = req.body;
    if (!year || !month || !day || !currencyFrom || !currencyTo || !value || !provider) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing required fields' });
      return;
    }

    // Validate currencies
    const { isValid, errors } = await validateCurrencies(
      currencyFrom.toUpperCase(),
      currencyTo.toUpperCase(),
      tenantId
    );

    if (!isValid) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Invalid currencies',
        details: errors
      });
      return;
    }

    // Prevent same currency conversion
    if (currencyFrom.toUpperCase() === currencyTo.toUpperCase()) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Invalid currency pair',
        details: 'Cannot create conversion rate between the same currency'
      });
      return;
    }

    const existing = await prisma.currencyRate.findUnique({
      where: { id: currencyRateId }
    });

    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Currency Rate not found' });
      return;
    }

    const updated = await prisma.currencyRate.update({
      where: { id: currencyRateId },
      data: {
        year: year ? parseInt(year, 10) : undefined,
        month: month ? parseInt(month, 10) : undefined,
        day: day ? parseInt(day, 10) : undefined,
        currencyFrom: currencyFrom.toUpperCase(),
        currencyTo: currencyTo.toUpperCase(),
        value: value,
        provider,
        updatedAt: new Date(),
      }
    });

    res.status(StatusCodes.OK).json(updated);
    return;
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Update Failed',
      details: error.message,
    });
  }
}

async function handleDelete(req, res) {
  const tenantId = req.user.tenantId;
  try {
    const { id } = req.query;
    const currencyRateId = parseInt(id, 10);
    if (isNaN(currencyRateId)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid currency rate ID' });
      return;
    }

    const existing = await prisma.currencyRate.findUnique({
      where: { id: currencyRateId }
    });

    if (!existing) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Currency Rate not found' });
      return;
    }

    // Validate tenant has access to both currencies
    const { isValid, errors } = await validateCurrencies(
      existing.currencyFrom,
      existing.currencyTo,
      tenantId
    );

    if (!isValid) {
      res.status(StatusCodes.FORBIDDEN).json({
        error: 'Access denied',
        details: errors
      });
      return;
    }

    await prisma.currencyRate.delete({ where: { id: currencyRateId } });

    res.status(StatusCodes.NO_CONTENT).end();
    return;
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Deletion Failed',
      details: error.message,
    });
  }
}
