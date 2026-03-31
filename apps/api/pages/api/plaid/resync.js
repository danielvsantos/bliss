/**
 * POST /api/plaid/resync?id=<plaidItemId>
 *
 * Triggers a manual re-sync for the given PlaidItem by emitting
 * a PLAID_SYNC_UPDATES event to the backend service.
 */

import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors';
import { rateLimiters } from '../../../utils/rateLimit';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';
import { produceEvent } from '../../../utils/produceEvent.js';

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    const limiter = rateLimiters.accounts || rateLimiters.common;
    if (limiter) {
      limiter(req, res, (result) => {
        if (result instanceof Error) return reject(result);
        resolve(result);
      });
    } else {
      resolve();
    }
  });

  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const { id } = req.query;
  if (!id) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing id query parameter' });
  }

  try {
    const user = req.user;

    const item = await prisma.plaidItem.findUnique({
      where: { id },
      select: { id: true, tenantId: true, status: true },
    });

    if (!item) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Plaid Item not found' });
    }

    if (item.tenantId !== user.tenantId) {
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
    }

    if (item.status !== 'ACTIVE') {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: `Cannot sync — item status is ${item.status}. Reconnect first.`,
      });
    }

    await produceEvent({
      type: 'PLAID_SYNC_UPDATES',
      tenantId: user.tenantId,
      plaidItemId: item.id,
      source: 'MANUAL_RESYNC',
    });

    return res.status(StatusCodes.OK).json({ message: 'Sync triggered' });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Resync error:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to trigger resync',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
