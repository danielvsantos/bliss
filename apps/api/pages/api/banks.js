import prisma from '../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../utils/cors';
import { rateLimiters } from '../../utils/rateLimit';
import { withAuth } from '../../utils/withAuth.js';

const BANK_NAME_MIN = 2;
const BANK_NAME_MAX = 100;

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.banks(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  // Handle CORS
  if (cors(req, res)) return;

  const user = req.user;
  const tenantId = user.tenantId;

  switch (req.method) {
    case 'GET':
      await handleGet(req, res);
      return;
    case 'POST':
      await handlePost(req, res, user, tenantId);
      return;
    default:
      res.setHeader('Allow', ['GET', 'POST']);
      res.status(StatusCodes.METHOD_NOT_ALLOWED).json({ error: `Method ${req.method} Not Allowed` });
      return;
  }
});

async function handleGet(req, res) {
  try {
    // Banks are reference data (like countries/currencies).
    // Return the full global list so onboarding & settings can pick from all of them.
    const banks = await prisma.bank.findMany({
      orderBy: { name: 'asc' },
    });
    res.status(StatusCodes.OK).json(banks);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to retrieve banks',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}

async function handlePost(req, res, user, tenantId) {
  const { name } = req.body;

  // Validate name exists and is a string
  if (!name || typeof name !== 'string') {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Bank name is required' });
  }

  // Trim and validate length
  const trimmedName = name.trim();
  if (trimmedName.length < BANK_NAME_MIN || trimmedName.length > BANK_NAME_MAX) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: `Bank name must be between ${BANK_NAME_MIN} and ${BANK_NAME_MAX} characters`,
    });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Upsert the global bank record (shared across tenants)
      const bank = await tx.bank.upsert({
        where: { name: trimmedName },
        update: {},
        create: { name: trimmedName },
      });

      // Link bank to tenant
      await tx.tenantBank.upsert({
        where: {
          tenantId_bankId: {
            tenantId,
            bankId: bank.id,
          },
        },
        update: {},
        create: {
          tenantId,
          bankId: bank.id,
        },
      });

      return bank;
    });

    res.status(StatusCodes.CREATED).json(result);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to create bank',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}
