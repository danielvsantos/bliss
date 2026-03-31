import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors';
import { rateLimiters } from '../../../utils/rateLimit';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';
import { produceEvent } from '../../../utils/produceEvent.js';

export default withAuth(async function handler(req, res) {
    // Rate Limiting
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

    // CORS
    if (cors(req, res)) return;

    try {
        const user = req.user;

        switch (req.method) {
            case 'GET':
                await handleGet(req, res, user);
                break;
            case 'PATCH':
                await handlePatch(req, res, user);
                break;
            default:
                res.setHeader('Allow', ['GET', 'PATCH']);
                res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
        }
    } catch (error) {
        Sentry.captureException(error);
        console.error('API Error:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'Server Error',
            ...(process.env.NODE_ENV === 'development' && { details: error.message }),
        });
    }
});

/**
 * GET /api/plaid/items
 * Returns all PlaidItems for the tenant with status info.
 */
async function handleGet(req, res, user) {
    const items = await prisma.plaidItem.findMany({
        where: { tenantId: user.tenantId },
        select: {
            id: true,
            itemId: true,
            status: true,
            errorCode: true,
            lastSync: true,
            historicalSyncComplete: true,
            earliestTransactionDate: true,
            seedReady: true,
            institutionName: true,
            institutionId: true,
            bankId: true,
            consentExpiration: true,
            environment: true,
            createdAt: true,
            accounts: {
                select: {
                    id: true,
                    name: true,
                    mask: true,
                    type: true,
                    subtype: true,
                }
            }
        },
        orderBy: { createdAt: 'desc' },
    });

    res.status(StatusCodes.OK).json(items);
}

/**
 * PATCH /api/plaid/items?id={plaidItemId}
 * Update a PlaidItem — primarily used to reset status after re-auth.
 * Body: { status?: string }
 */
async function handlePatch(req, res, user) {
    const { id } = req.query;
    if (!id) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing id query parameter' });
    }

    // Verify the item exists and belongs to the tenant
    const item = await prisma.plaidItem.findUnique({
        where: { id },
    });

    if (!item) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'Plaid Item not found' });
    }

    if (item.tenantId !== user.tenantId) {
        return res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
    }

    const { status } = req.body;

    // Only allow resetting to ACTIVE (for after successful re-auth)
    const updateData = {};
    if (status === 'ACTIVE') {
        updateData.status = 'ACTIVE';
        updateData.errorCode = null;
    }

    const updated = await prisma.plaidItem.update({
        where: { id },
        data: updateData,
        select: {
            id: true,
            status: true,
            errorCode: true,
            lastSync: true,
            institutionName: true,
        },
    });

    // After a successful re-auth, trigger an incremental sync to catch up on
    // any transactions that arrived while the connection was paused/broken.
    // Fire-and-forget — don't block the response on this.
    if (status === 'ACTIVE') {
        produceEvent({
            type: 'PLAID_SYNC_UPDATES',
            tenantId: item.tenantId,
            plaidItemId: id,
            source: 'RECONNECT_SYNC',
        }).catch((err) => {
            console.error('[items] Failed to trigger post-reconnect sync:', err.message);
        });
    }

    res.status(StatusCodes.OK).json(updated);
}
