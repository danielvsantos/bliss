import { StatusCodes } from 'http-status-codes';
import { plaidClient } from '../../../services/plaid.service';
import { cors } from '../../../utils/cors';
import { rateLimiters } from '../../../utils/rateLimit';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';

// Plaid only supports a subset of ISO country codes; same list as create-link-token.js
const PLAID_SUPPORTED_COUNTRIES = ['US', 'CA', 'GB', 'DE', 'FR', 'ES', 'NL', 'IE', 'IT'];

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
            case 'GET':
                await handleGet(req, res, user);
                break;
            default:
                res.setHeader('Allow', ['GET']);
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

async function handleGet(req, res, user) {
    const { plaidItemId } = req.query;
    if (!plaidItemId) {
        res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing plaidItemId' });
        return;
    }

    // Verify ownership
    const item = await prisma.plaidItem.findUnique({
        where: { id: plaidItemId },
    });

    if (!item) {
        res.status(StatusCodes.NOT_FOUND).json({ error: 'Plaid Item not found' });
        return;
    }

    if (item.tenantId !== user.tenantId) {
        res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied to this Item' });
        return;
    }

    try {
        // Fetch Plaid accounts and tenant config in parallel
        const [plaidResponse, tenantCurrenciesResult, tenantCountriesResult] = await Promise.all([
            plaidClient.accountsGet({ access_token: item.accessToken }),
            prisma.tenantCurrency.findMany({
                where: { tenantId: item.tenantId },
                select: { currencyId: true, isDefault: true },
                orderBy: { isDefault: 'desc' }, // default first — preserves default on PUT
            }),
            prisma.tenantCountry.findMany({
                where: { tenantId: item.tenantId },
                include: { country: { select: { id: true, iso2: true } } },
                orderBy: { isDefault: 'desc' }, // default first
            }),
        ]);

        const tenantCurrencyIds  = tenantCurrenciesResult.map(tc => tc.currencyId);
        // Build both the 3-letter id list (for FK) and iso2 list (for Plaid comparison)
        const tenantCountries    = tenantCountriesResult.map(tc => ({ id: tc.countryId, iso2: tc.country.iso2 }));
        const tenantCountryIso2s = tenantCountries.map(tc => tc.iso2).filter(Boolean);

        const accounts = plaidResponse.data.accounts.map(acc => ({
            accountId: acc.account_id,
            name: acc.name,
            mask: acc.mask,
            type: acc.type,
            subtype: acc.subtype,
            currentBalance: acc.balances.current,
            isoCurrencyCode: acc.balances.iso_currency_code,
            isCurrencySupported: tenantCurrencyIds.includes(acc.balances.iso_currency_code ?? ''),
        }));

        const unsupportedCurrencies = [
            ...new Set(
                accounts
                    .filter(a => !a.isCurrencySupported && a.isoCurrencyCode)
                    .map(a => a.isoCurrencyCode)
            ),
        ];

        // Best-effort institution country lookup — never fails the whole request
        let institutionCountry = null;
        if (item.institutionId) {
            try {
                const instResponse = await plaidClient.institutionsGetById({
                    institution_id: item.institutionId,
                    country_codes: PLAID_SUPPORTED_COUNTRIES,
                });
                institutionCountry = instResponse.data.institution.country_codes?.[0] ?? null;
            } catch (_) {
                // institution lookup is best-effort; don't block account listing
            }
        }

        // Compare Plaid's 2-letter code against tenant's iso2 codes (not the 3-letter ids)
        const unsupportedCountry = (
            institutionCountry && !tenantCountryIso2s.includes(institutionCountry)
        ) ? institutionCountry : null;

        // Resolve the 3-letter id for the unsupported country so the modal can pass it to updateTenant
        let unsupportedCountryId = null;
        if (unsupportedCountry) {
            const countryRecord = await prisma.country.findFirst({
                where: { iso2: unsupportedCountry },
                select: { id: true },
            });
            unsupportedCountryId = countryRecord?.id ?? null;
        }

        res.status(StatusCodes.OK).json({
            accounts,
            institution: plaidResponse.data.item.institution_id,
            tenantId: item.tenantId,
            tenantCurrencies: tenantCurrencyIds,
            unsupportedCurrencies,
            tenantCountries,          // array of { id (3-letter), iso2 (2-letter) }
            institutionCountry,       // 2-letter Plaid code or null
            unsupportedCountry,       // 2-letter code if new, else null
            unsupportedCountryId,     // 3-letter id for updateTenant FK
        });
    } catch (error) {
        if (error.response?.data) {
            console.error('Plaid Accounts Error:', error.response.data);
        }
        throw error;
    }
}
