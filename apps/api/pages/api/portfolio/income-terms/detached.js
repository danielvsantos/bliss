import prisma from '../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { withAuth } from '../../../../utils/withAuth.js';
import { serializeIncomeTerms } from '../../../../services/incomeTerms.service.js';

/**
 * GET /api/portfolio/income-terms/detached
 *
 * Income terms whose asset was pruned by a portfolio rebuild that re-keyed it
 * (a corrected import) and that could not be moved to a single clear match.
 * Listed on the Passive Income page for re-attaching or discarding.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const rows = await prisma.incomeTerms.findMany({
      where: { tenantId: req.user.tenantId, assetId: null, categoryId: null, orphanedAt: { not: null } },
      orderBy: { orphanedAt: 'desc' },
    });
    return res.status(StatusCodes.OK).json({ detached: rows.map(serializeIncomeTerms) });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
