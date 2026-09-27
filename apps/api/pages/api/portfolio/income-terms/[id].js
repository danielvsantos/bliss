import prisma from '../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { withAuth } from '../../../../utils/withAuth.js';

/**
 * DELETE /api/portfolio/income-terms/:id — discard a DETACHED income terms row.
 * Only allowed while the row is detached (no asset and no category owner);
 * attached terms are removed through their asset or stream routes.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'DELETE') {
    res.setHeader('Allow', ['DELETE']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const id = parseInt(req.query.id, 10);
  if (Number.isNaN(id)) return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid income terms ID' });

  try {
    const row = await prisma.incomeTerms.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!row) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Income terms not found' });
    if (row.assetId != null || row.categoryId != null) {
      return res.status(StatusCodes.CONFLICT).json({ error: 'Only detached income terms can be discarded here' });
    }
    await prisma.incomeTerms.delete({ where: { id } });
    return res.status(StatusCodes.NO_CONTENT).end();
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
