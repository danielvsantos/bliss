import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

const VALID_AMOUNT_STRATEGIES = ['SINGLE_SIGNED', 'SINGLE_SIGNED_INVERTED', 'DEBIT_CREDIT_COLUMNS', 'AMOUNT_WITH_TYPE'];

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsAdapters(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  try {
    const user = req.user;

    if (req.method === 'GET') {
      await handleGet(req, res, user);
    } else if (req.method === 'POST') {
      await handlePost(req, res, user);
    } else {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      details: error.message,
    });
  }
});

/**
 * GET /api/imports/adapters
 * List all adapters accessible by the tenant (tenant-specific + global).
 */
async function handleGet(req, res, user) {
  const adapters = await prisma.importAdapter.findMany({
    where: {
      isActive: true,
      OR: [{ tenantId: user.tenantId }, { tenantId: null }],
    },
    orderBy: [{ tenantId: 'desc' }, { name: 'asc' }],
  });

  return res.status(StatusCodes.OK).json({ adapters });
}

/**
 * POST /api/imports/adapters
 * Create a new tenant-specific adapter.
 */
async function handlePost(req, res, user) {
  const { name, matchSignature, columnMapping, dateFormat, amountStrategy, currencyDefault, skipRows } = req.body;

  // Validation
  if (!name || typeof name !== 'string' || name.length < 2 || name.length > 100) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'name is required (2-100 characters)' });
  }

  if (!matchSignature || !Array.isArray(matchSignature.headers) || matchSignature.headers.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'matchSignature.headers is required (non-empty array)' });
  }

  if (!columnMapping || typeof columnMapping !== 'object') {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'columnMapping is required (object)' });
  }
  if (!columnMapping.date) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'columnMapping.date is required' });
  }
  if (!columnMapping.description) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'columnMapping.description is required' });
  }

  if (!amountStrategy || !VALID_AMOUNT_STRATEGIES.includes(amountStrategy)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: `amountStrategy must be one of: ${VALID_AMOUNT_STRATEGIES.join(', ')}`,
    });
  }

  // Amount columns required depending on strategy
  if (amountStrategy === 'DEBIT_CREDIT_COLUMNS' && (!columnMapping.debit || !columnMapping.credit)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'columnMapping.debit and columnMapping.credit are required for DEBIT_CREDIT_COLUMNS strategy',
    });
  }
  if ((amountStrategy === 'SINGLE_SIGNED' || amountStrategy === 'AMOUNT_WITH_TYPE') && !columnMapping.amount) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'columnMapping.amount is required for this amountStrategy',
    });
  }

  const adapter = await prisma.importAdapter.create({
    data: {
      name,
      matchSignature,
      columnMapping,
      dateFormat: dateFormat || null,
      amountStrategy,
      currencyDefault: currencyDefault || null,
      skipRows: skipRows || 0,
      tenantId: user.tenantId, // Always tenant-scoped for user-created adapters
    },
  });

  return res.status(StatusCodes.CREATED).json({ adapter });
}
