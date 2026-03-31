/**
 * POST /api/plaid/fetch-historical?id=<plaidItemId>
 * Body: { fromDate: "YYYY-MM-DD" }
 *
 * Triggers a historical transaction backfill for the given PlaidItem
 * by emitting a PLAID_HISTORICAL_BACKFILL event to the backend service.
 * Uses Plaid's transactions/get endpoint to fetch older transactions.
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
  const { fromDate } = req.body || {};

  if (!id) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing id query parameter' });
  }

  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Missing or invalid fromDate (expected YYYY-MM-DD)',
    });
  }

  // Validate fromDate is within 2 years
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const fromDateObj = new Date(fromDate + 'T00:00:00Z');

  if (fromDateObj < twoYearsAgo) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'fromDate cannot be more than 2 years in the past',
    });
  }

  if (fromDateObj > new Date()) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'fromDate cannot be in the future',
    });
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
        error: `Cannot fetch historical data — item status is ${item.status}. Reconnect first.`,
      });
    }

    await produceEvent({
      type: 'PLAID_HISTORICAL_BACKFILL',
      tenantId: user.tenantId,
      plaidItemId: item.id,
      fromDate,
    });

    return res.status(StatusCodes.OK).json({ message: 'Historical backfill triggered' });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Fetch historical error:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to trigger historical backfill',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
