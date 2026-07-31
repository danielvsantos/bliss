import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { cors } from '../../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { produceEvent } from '../../../../../utils/produceEvent.js';
import { withAuth } from '../../../../../utils/withAuth.js';

/**
 * POST /api/plaid/transactions/:id/retry
 *
 * Manually retries classification for a PlaidTransaction stuck in FAILED status.
 * Validates + resets the row + enqueues a backend event, then returns 202 —
 * the actual reclassification happens asynchronously in plaidProcessorWorker.
 *
 * classificationRetryCount is deliberately set to 1 (not 0) on reset: if this
 * manual retry also fails, the worker's own retry-then-FAILED logic sends it
 * straight to FAILED again rather than silently re-queuing another invisible
 * 60s retry — a user-initiated Retry must always land in a new terminal state.
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

    const { id } = req.query;
    if (!id) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing transaction ID' });
    }

    const plaidTx = await prisma.plaidTransaction.findUnique({
      where: { id },
      include: {
        plaidItem: { select: { id: true, tenantId: true } },
      },
    });

    if (!plaidTx) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'PlaidTransaction not found' });
    }

    if (plaidTx.plaidItem.tenantId !== user.tenantId) {
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
    }

    if (plaidTx.promotionStatus !== 'FAILED') {
      return res.status(StatusCodes.CONFLICT).json({
        error: `Cannot retry a transaction with promotionStatus '${plaidTx.promotionStatus}'. Only FAILED transactions can be retried.`,
      });
    }

    const updated = await prisma.plaidTransaction.update({
      where: { id },
      data: {
        processed: false,
        promotionStatus: 'PENDING',
        processingError: null,
        classificationRetryCount: 1,
      },
    });

    await produceEvent({
      type: 'PLAID_TRANSACTION_RETRY',
      tenantId: user.tenantId,
      plaidItemId: plaidTx.plaidItem.id,
    });

    return res.status(StatusCodes.ACCEPTED).json(updated);
  } catch (error) {
    Sentry.captureException(error);
    console.error('Plaid transaction retry error:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
