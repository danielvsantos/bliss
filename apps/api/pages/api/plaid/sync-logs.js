/**
 * GET /api/plaid/sync-logs?plaidItemId=<id>&limit=<n>
 *
 * Returns recent sync logs for a PlaidItem.
 * Default limit: 20 most recent entries.
 */

import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors';
import { rateLimiters } from '../../../utils/rateLimit';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';

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

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const { plaidItemId, limit } = req.query;
  if (!plaidItemId) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing plaidItemId query parameter' });
  }

  try {
    const user = req.user;

    // Verify the PlaidItem belongs to the tenant
    const item = await prisma.plaidItem.findUnique({
      where: { id: plaidItemId },
      select: { tenantId: true },
    });

    if (!item) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Plaid Item not found' });
    }

    if (item.tenantId !== user.tenantId) {
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
    }

    const take = Math.min(parseInt(limit) || 20, 100);

    const logs = await prisma.plaidSyncLog.findMany({
      where: { plaidItemId },
      orderBy: { createdAt: 'desc' },
      take,
    });

    return res.status(StatusCodes.OK).json(logs);
  } catch (error) {
    Sentry.captureException(error);
    console.error('Sync logs error:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to fetch sync logs',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
