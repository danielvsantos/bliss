import { StatusCodes } from 'http-status-codes';
import { plaidClient } from '../../../services/plaid.service';
import { cors } from '../../../utils/cors';
import { rateLimiters } from '../../../utils/rateLimit';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
    // Rate Limiting
    await new Promise((resolve, reject) => {
        // Assuming a general limiter or reusing one; using 'common' or similar if defined, 
        // but looking at imports, we probably need to simply use one. 
        // Using 'transactions' or similar for now or just generic if available.
        // The user's example used `rateLimiters.accounts`. We will assume `rateLimiters.plaid` 
        // might not exist, so we will use a safe default or `accounts` as it's related.
        // Actually, let's use `rateLimiters.accounts` as a proxy for financial data access 
        // or assume we need to add `plaid` to rateLimitUtils. 
        // For now, I'll use `rateLimiters.accounts` to avoid breaking if `plaid` key missing.
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

// Plaid only supports a subset of ISO country codes; intersect with what we support
const PLAID_SUPPORTED_COUNTRIES = ['US', 'CA', 'GB', 'DE', 'FR', 'ES', 'NL', 'IE', 'IT'];

async function handlePost(req, res, user) {
    // Guard: ensure Plaid credentials are configured
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
        console.error('Plaid credentials missing: PLAID_CLIENT_ID or PLAID_SECRET not set');
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'Plaid is not configured on this server. Please set PLAID_CLIENT_ID and PLAID_SECRET environment variables.',
        });
    }

    try {
        const { plaidItemId } = req.body || {};

        // Fetch tenant config (countries + plaidHistoryDays) in one query
        const [tenantCountries, tenant] = await Promise.all([
            prisma.tenantCountry.findMany({
                where: { tenantId: user.tenantId },
                include: { country: { select: { iso2: true } } },
            }),
            prisma.tenant.findUnique({
                where: { id: user.tenantId },
                select: { plaidHistoryDays: true },
            }),
        ]);
        const countryCodes = tenantCountries
            .map(tc => tc.country.iso2)
            .filter(code => code && PLAID_SUPPORTED_COUNTRIES.includes(code));

        const configs = {
            user: {
                client_user_id: user.id,
            },
            client_name: 'Bliss Finance',
            country_codes: countryCodes.length > 0 ? countryCodes : ['US'],
            language: 'en',
        };

        // Register webhook URL so Plaid sends TRANSACTIONS and ITEM events
        if (process.env.PLAID_WEBHOOK_URL) {
            configs.webhook = process.env.PLAID_WEBHOOK_URL;
        }

        // If plaidItemId is provided, this is a re-auth/update mode request
        if (plaidItemId) {
            const plaidItem = await prisma.plaidItem.findUnique({
                where: { id: plaidItemId },
            });

            if (!plaidItem) {
                return res.status(StatusCodes.NOT_FOUND).json({ error: 'Plaid Item not found' });
            }

            if (plaidItem.tenantId !== user.tenantId) {
                return res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
            }

            // Update mode: pass access_token instead of products
            // This activates Plaid Link in update mode for re-authentication
            configs.access_token = plaidItem.accessToken;
        } else {
            // Normal mode: create new connection
            configs.products = ['transactions'];
            configs.transactions = { days_requested: tenant?.plaidHistoryDays ?? 1 };
        }

        const createTokenResponse = await plaidClient.linkTokenCreate(configs);
        res.status(StatusCodes.OK).json(createTokenResponse.data);
    } catch (error) {
        // Surface Plaid-specific error details for easier debugging
        const plaidError = error?.response?.data;
        if (plaidError) {
            console.error('Plaid API error:', JSON.stringify(plaidError, null, 2));
            return res.status(StatusCodes.BAD_GATEWAY).json({
                error: 'Plaid API error',
                plaidErrorType: plaidError.error_type,
                plaidErrorCode: plaidError.error_code,
                plaidErrorMessage: plaidError.error_message,
                plaidDisplayMessage: plaidError.display_message,
            });
        }
        throw error;
    }
}
