/**
 * POST /api/plaid/disconnect?id=<plaidItemId>
 *
 * Soft-disconnects a Plaid connection:
 *   1. Sets PlaidItem.status to REVOKED locally (no Plaid API call).
 *   2. Writes an audit log entry.
 *
 * We intentionally do NOT call plaidClient.itemRemove() here.
 * itemRemove() is a permanent, irreversible operation on Plaid's side —
 * once called, the Item is destroyed and the access token is invalidated
 * forever, making reconnection via Plaid Link update mode impossible.
 *
 * By only updating the local status we preserve the access token so the
 * user can reconnect at any time. The plaidSyncWorker skips items whose
 * status is not ACTIVE, so no new transactions will be pulled.
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

    // Fetch the item — accessToken decrypted by Prisma middleware
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

    if (item.status === 'REVOKED') {
      return res.status(StatusCodes.CONFLICT).json({ error: 'Connection already disconnected' });
    }

    // Mark as revoked locally — token intentionally kept valid for reconnection
    await prisma.plaidItem.update({
      where: { id },
      data: {
        status: 'REVOKED',
        updatedAt: new Date(),
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: user.email,
        action: 'UPDATE',
        table: 'PlaidItem',
        recordId: id,
        tenantId: user.tenantId,
      },
    });

    return res.status(StatusCodes.OK).json({ message: 'Connection disconnected' });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Disconnect error:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to disconnect',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
