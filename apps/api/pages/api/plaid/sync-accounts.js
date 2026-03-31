import { StatusCodes } from 'http-status-codes';
import { plaidClient } from '../../../services/plaid.service';
import { cors } from '../../../utils/cors';
import { rateLimiters } from '../../../utils/rateLimit';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { produceEvent } from '../../../utils/produceEvent.js';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
    // Rate Limit
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
    const { plaidItemId, selectedAccountIds, countryId: providedCountryId, accountMappings, accountNames } = req.body;

    if (!plaidItemId || !Array.isArray(selectedAccountIds) || selectedAccountIds.length === 0) {
        res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid input' });
        return;
    }

    const item = await prisma.plaidItem.findUnique({
        where: { id: plaidItemId },
        include: { bank: true }
    });

    if (!item) {
        res.status(StatusCodes.NOT_FOUND).json({ error: 'Item not found' });
        return;
    }

    if (item.tenantId !== user.tenantId) {
        res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
        return;
    }

    // Verify accounts with Plaid again to get latest metadata
    const plaidRes = await plaidClient.accountsGet({
        access_token: item.accessToken,
    });
    const allPlaidAccounts = plaidRes.data.accounts;
    const accountsToSync = allPlaidAccounts.filter(acc => selectedAccountIds.includes(acc.account_id));

    // Resolve countryId once before the transaction (read-only, no transactional need)
    // providedCountryId is a 2-letter Plaid code (e.g. "US") — look up the 3-letter Country.id via iso2
    let resolvedCountryId;
    if (providedCountryId) {
        const countryRecord = await prisma.country.findFirst({
            where: { iso2: providedCountryId },
            select: { id: true },
        });
        resolvedCountryId = countryRecord?.id;
    }
    if (!resolvedCountryId) {
        const tenantDefaultCountry = await prisma.tenantCountry.findFirst({
            where: { tenantId: item.tenantId, isDefault: true },
        });
        resolvedCountryId = tenantDefaultCountry?.countryId;
    }

    // Transaction to create or link accounts
    const mappings = accountMappings && typeof accountMappings === 'object' ? accountMappings : {};
    const names = accountNames && typeof accountNames === 'object' ? accountNames : {};

    await prisma.$transaction(async (tx) => {
        for (const acc of accountsToSync) {
            let bankId = item.bankId;
            if (!bankId) {
                const defaultBank = await tx.bank.findFirst();
                bankId = defaultBank?.id;
            }

            let currency = await tx.currency.findUnique({ where: { id: acc.balances.iso_currency_code } });
            if (!currency) {
                currency = await tx.currency.findFirst();
            }

            const existing = await tx.account.findFirst({
                where: {
                    tenantId: item.tenantId,
                    plaidAccountId: acc.account_id
                }
            });

            if (!existing) {
                // Check if user wants to link to an existing manual account
                const linkTargetId = mappings[acc.account_id];
                if (linkTargetId) {
                    const targetAccount = await tx.account.findFirst({
                        where: {
                            id: linkTargetId,
                            tenantId: item.tenantId,
                            plaidAccountId: null, // Must be a manual account (not already linked)
                        },
                    });
                    if (targetAccount) {
                        // Link: update existing manual account with Plaid fields
                        await tx.account.update({
                            where: { id: targetAccount.id },
                            data: {
                                plaidAccountId: acc.account_id,
                                plaidItemId: item.id,
                                mask: acc.mask,
                                type: acc.type,
                                subtype: acc.subtype,
                            },
                        });
                        continue; // Skip create — account is linked
                    }
                    // If target not found or already linked, fall through to create
                }

                await tx.account.create({
                    data: {
                        name: names[acc.account_id] || acc.name,
                        accountNumber: acc.mask || 'XXXX',
                        bankId: bankId,
                        countryId: resolvedCountryId,
                        currencyCode: currency.id,
                        tenantId: item.tenantId,
                        plaidAccountId: acc.account_id,
                        plaidItemId: item.id,
                        mask: acc.mask,
                        type: acc.type,
                        subtype: acc.subtype
                    }
                });
            }
        }

        await tx.plaidItem.update({
            where: { id: plaidItemId },
            data: { status: 'ACTIVE' }
        });
    });

    // Trigger Initial Sync Event
    await produceEvent({
        type: 'PLAID_INITIAL_SYNC',
        tenantId: item.tenantId,
        plaidItemId: item.id,
        accountIds: selectedAccountIds
    });

    res.status(StatusCodes.OK).json({ success: true, message: 'Accounts linked and sync started' });
}
