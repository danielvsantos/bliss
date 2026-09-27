import prisma from '../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { withAuth } from '../../../../utils/withAuth.js';
import {
  validateBody,
  toIncomeTermsData,
  findEligibleCategory,
  serializeStream,
} from '../../../../services/incomeTerms.service.js';

/**
 * One income stream (Passive Income, #77).
 *   PUT    → update (validated; category must stay eligible)
 *   DELETE → delete
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  const id = parseInt(req.query.id, 10);
  if (Number.isNaN(id)) return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid stream ID' });

  try {
    const existing = await prisma.incomeTerms.findFirst({
      where: { id, tenantId: req.user.tenantId, categoryId: { not: null } },
    });

    switch (req.method) {
      case 'PUT': {
        if (!existing) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Income stream not found' });
        const body = {
          ...(req.body || {}),
          incomeType: req.body?.incomeType || 'FIXED_AMOUNT',
          categoryId: req.body?.categoryId ?? existing.categoryId,
        };
        const invalid = validateBody(body, 'stream');
        if (invalid) return res.status(StatusCodes.BAD_REQUEST).json(invalid);
        const category = await findEligibleCategory(req.user.tenantId, body.categoryId);
        if (!category) {
          return res.status(StatusCodes.BAD_REQUEST).json({ error: 'categoryId is not eligible for income streams' });
        }
        const row = await prisma.incomeTerms.update({
          where: { id },
          data: { ...toIncomeTermsData(body), categoryId: category.id },
          include: { category: { select: { name: true, defaultCategoryCode: true } } },
        });
        return res.status(StatusCodes.OK).json(serializeStream(row));
      }
      case 'DELETE': {
        if (!existing) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Income stream not found' });
        await prisma.incomeTerms.delete({ where: { id } });
        return res.status(StatusCodes.NO_CONTENT).end();
      }
      default:
        res.setHeader('Allow', ['PUT', 'DELETE']);
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
