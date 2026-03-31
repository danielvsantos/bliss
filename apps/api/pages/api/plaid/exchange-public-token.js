import { StatusCodes } from 'http-status-codes';
import { plaidClient } from '../../../services/plaid.service';
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

    try {
        const user = req.user;

        switch (req.method) {
            case 'POST':
                await handlePost(req, res, user);
                break;
            default:
                res.setHeader('Allow', ['POST']);
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

async function handlePost(req, res, user) {
    const { public_token, institutionId, institutionName, bankName } = req.body;

    if (!public_token) {
        res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing public_token' });
        return;
    }

    try {
        const response = await plaidClient.itemPublicTokenExchange({
            public_token,
        });
        const { access_token, item_id } = response.data;

        let bankId = null;
        const targetName = bankName || institutionName;

        if (targetName) {
            const bank = await prisma.bank.upsert({
                where: { name: targetName },
                update: {},
                create: { name: targetName }
            });
            bankId = bank.id;

            await prisma.tenantBank.upsert({
                where: {
                    tenantId_bankId: {
                        tenantId: user.tenantId,
                        bankId: bank.id
                    }
                },
                update: {},
                create: {
                    tenantId: user.tenantId,
                    bankId: bank.id
                }
            });
        }

        const plaidItem = await prisma.plaidItem.upsert({
            where: { itemId: item_id },
            update: {
                accessToken: access_token,  // Prisma middleware encrypts automatically
                status: 'PENDING_SELECTION',
                updatedAt: new Date(),
                bankId: bankId,
            },
            create: {
                tenantId: user.tenantId,
                userId: user.id,
                itemId: item_id,
                accessToken: access_token,  // Prisma middleware encrypts automatically
                institutionId,
                institutionName,
                bankId,
                status: 'PENDING_SELECTION',
                environment: process.env.PLAID_ENV || 'sandbox',
            },
        });

        res.status(StatusCodes.OK).json({ plaidItemId: plaidItem.id });
    } catch (error) {
        if (error.response?.data) {
            console.error('Plaid Exchange Error:', error.response.data);
        }
        throw error;
    }
}
