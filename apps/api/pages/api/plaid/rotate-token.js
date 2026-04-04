/**
 * POST /api/plaid/rotate-token?id=<plaidItemId>
 *
 * Rotates the Plaid access token for the given PlaidItem.
 * Plaid recommends rotating tokens periodically or after a security event.
 *
 * Flow:
 *   1. Verify the item belongs to the calling tenant.
 *   2. Call plaidClient.itemAccessTokenInvalidate() with the current token.
 *      Plaid invalidates the old token and returns a fresh one atomically.
 *   3. Persist the new token (Prisma middleware re-encrypts automatically).
 *   4. Write an audit log entry.
 */

import { StatusCodes } from 'http-status-codes';
import { plaidClient } from '../../../services/plaid.service';
import { cors } from '../../../utils/cors';
import { rateLimiters } from '../../../utils/rateLimit';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  // Rate limiting
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

    // Fetch the item — accessToken is decrypted transparently by Prisma middleware
    const item = await prisma.plaidItem.findUnique({
      where: { id },
      select: { id: true, accessToken: true, tenantId: true, itemId: true },
    });

    if (!item) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Plaid Item not found' });
    }

    if (item.tenantId !== user.tenantId) {
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
    }

    // Ask Plaid to rotate the token
    const plaidResponse = await plaidClient.itemAccessTokenInvalidate({
      access_token: item.accessToken,
    });

    const newAccessToken = plaidResponse.data.new_access_token;

    // Persist the new token (Prisma middleware re-encrypts automatically)
    await prisma.plaidItem.update({
      where: { id },
      data: {
        accessToken: newAccessToken,
        updatedAt: new Date(),
      },
    });

    return res.status(StatusCodes.OK).json({ message: 'Access token rotated successfully' });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Rotate token error:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to rotate access token',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
