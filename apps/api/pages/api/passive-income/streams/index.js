import prisma from '../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { withAuth } from '../../../../utils/withAuth.js';
import { isStreamEligibleCategory } from '@bliss/shared/portfolio';
import {
  validateBody,
  toIncomeTermsData,
  serializeStream,
  findEligibleCategory,
  STREAM_CATEGORY_SELECT,
} from '../../../../services/incomeTerms.service.js';

/**
 * Income streams not tied to an asset (Allowance, Government Welfare, custom
 * "Passive Income" categories) — Passive Income, #77.
 *
 *   GET  → { streams: [...], eligibleCategories: [...] }
 *   POST → create a stream (incomeType FIXED_AMOUNT, eligible category)
 */
export default withAuth(async function handler(req, res) {
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
        return await handleGet(req, res);
      case 'POST':
        return await handlePost(req, res);
      default:
        res.setHeader('Allow', ['GET', 'POST']);
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

async function handleGet(req, res) {
  const { tenantId } = req.user;
  const [rows, categories] = await Promise.all([
    prisma.incomeTerms.findMany({
      where: { tenantId, categoryId: { not: null } },
      include: { category: { select: { name: true, defaultCategoryCode: true } } },
      orderBy: [{ createdAt: 'asc' }],
    }),
    prisma.category.findMany({
      where: { tenantId, type: 'Income', group: 'Passive Income' },
      select: STREAM_CATEGORY_SELECT,
      orderBy: { name: 'asc' },
    }),
  ]);
  return res.status(StatusCodes.OK).json({
    streams: rows.map(serializeStream),
    eligibleCategories: categories
      .filter(isStreamEligibleCategory)
      .map((c) => ({ id: c.id, name: c.name, defaultCategoryCode: c.defaultCategoryCode || null })),
  });
}

async function handlePost(req, res) {
  const { tenantId } = req.user;
  const body = { ...(req.body || {}), incomeType: req.body?.incomeType || 'FIXED_AMOUNT' };
  const invalid = validateBody(body, 'stream');
  if (invalid) return res.status(StatusCodes.BAD_REQUEST).json(invalid);

  const category = await findEligibleCategory(tenantId, body.categoryId);
  if (!category) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'categoryId must be an Income category in the "Passive Income" group that is not produced by an asset',
    });
  }

  const row = await prisma.incomeTerms.create({
    data: { ...toIncomeTermsData(body), tenantId, categoryId: category.id },
    include: { category: { select: { name: true, defaultCategoryCode: true } } },
  });
  return res.status(StatusCodes.CREATED).json(serializeStream(row));
}
