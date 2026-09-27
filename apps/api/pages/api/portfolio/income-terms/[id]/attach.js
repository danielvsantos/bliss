import prisma from '../../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../utils/cors.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { withAuth } from '../../../../../utils/withAuth.js';
import { serializeIncomeTerms } from '../../../../../services/incomeTerms.service.js';

/**
 * POST /api/portfolio/income-terms/:id/attach  { assetId }
 *
 * Re-attaches a detached income terms row to one of the tenant's portfolio
 * items. The target must belong to the tenant and must not have terms yet.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const id = parseInt(req.query.id, 10);
  const assetId = parseInt(req.body?.assetId, 10);
  if (Number.isNaN(id)) return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid income terms ID' });
  if (Number.isNaN(assetId)) return res.status(StatusCodes.BAD_REQUEST).json({ error: 'assetId is required' });

  const { tenantId } = req.user;
  try {
    const row = await prisma.incomeTerms.findFirst({ where: { id, tenantId } });
    if (!row) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Income terms not found' });
    if (row.assetId != null || row.categoryId != null) {
      return res.status(StatusCodes.CONFLICT).json({ error: 'Income terms are not detached' });
    }

    const target = await prisma.portfolioItem.findFirst({
      where: { id: assetId, tenantId },
      select: { id: true, currency: true, incomeTerms: { select: { id: true } } },
    });
    if (!target) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Portfolio item not found' });
    if (target.incomeTerms) {
      return res.status(StatusCodes.CONFLICT).json({ error: 'The target asset already has income terms' });
    }

    const updated = await prisma.incomeTerms.update({
      where: { id },
      data: { assetId, orphanedAt: null, orphanedLabel: null },
    });
    return res.status(StatusCodes.OK).json({ terms: serializeIncomeTerms(updated) });
  } catch (error) {
    Sentry.captureException(error);
    if (error.code === 'P2002') {
      return res.status(StatusCodes.CONFLICT).json({ error: 'The target asset already has income terms' });
    }
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
