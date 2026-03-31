import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { cors } from '../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../utils/withAuth.js';

/**
 * POST /api/plaid/transactions/bulk-requeue
 *
 * Re-queues all SKIPPED PlaidTransactions back to CLASSIFIED for review.
 * Optionally filtered by plaidItemId.
 *
 * Body: { plaidItemId?: string }
 * Returns: { updated: number }
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    const limiter = rateLimiters.plaidReview || rateLimiters.accounts;
    limiter(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const user = req.user;
    const { plaidItemId } = req.body;

    // Get tenant's Plaid items
    const tenantPlaidItems = await prisma.plaidItem.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true },
    });
    const tenantPlaidItemIds = tenantPlaidItems.map((pi) => pi.id);

    if (tenantPlaidItemIds.length === 0) {
      return res.status(StatusCodes.OK).json({ updated: 0 });
    }

    // Build filter
    const where = {
      plaidItemId: plaidItemId
        ? { in: tenantPlaidItemIds.includes(plaidItemId) ? [plaidItemId] : [] }
        : { in: tenantPlaidItemIds },
      promotionStatus: 'SKIPPED',
    };

    const result = await prisma.plaidTransaction.updateMany({
      where,
      data: {
        promotionStatus: 'CLASSIFIED',
        processed: false,
      },
    });

    res.status(StatusCodes.OK).json({ updated: result.count });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Bulk requeue error:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
