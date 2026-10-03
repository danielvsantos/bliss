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
    let result;
    try {
      result = await linkBank(tenantId, trimmedName);
    } catch (error) {
      // Two concurrent creates of the same new name race on Bank.name: the
      // loser retries once and finds the winner's row.
      if (error?.code !== 'P2002') throw error;
      result = await linkBank(tenantId, trimmedName);
    }

    // 201 when this call linked the bank to the tenant, 200 when it already
    // was (#98: lets create_bank report `created`). Same body either way.
    res.status(result.linked ? StatusCodes.CREATED : StatusCodes.OK).json(result.bank);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to create bank',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}

/**
 * Find-or-create the global bank (an existing name is reused whatever its
 * casing, so "revolut" and "Revolut" resolve to one bank) and link it to the
 * tenant. Idempotent.
 *
 * @returns {Promise<{ bank: object, linked: boolean }>} `linked` is true when
 *   the TenantBank row was created by this call.
 */
async function linkBank(tenantId, trimmedName) {
  return prisma.$transaction(async (tx) => {
    // Prefer the exact name; fall back to the oldest case-insensitive match.
    const existing = await tx.bank.findUnique({ where: { name: trimmedName } })
      ?? await tx.bank.findFirst({
        where: { name: { equals: trimmedName, mode: 'insensitive' } },
        orderBy: { id: 'asc' },
      });

    // Upsert the global bank record (shared across tenants)
    const bank = existing ?? await tx.bank.upsert({
      where: { name: trimmedName },
      update: {},
      create: { name: trimmedName },
    });

    const link = await tx.tenantBank.findUnique({
      where: { tenantId_bankId: { tenantId, bankId: bank.id } },
    });
    if (link) return { bank, linked: false };

    // Link bank to tenant
    await tx.tenantBank.create({ data: { tenantId, bankId: bank.id } });
    return { bank, linked: true };
  });
}
