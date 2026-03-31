import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../utils/withAuth.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

/**
 * POST /api/plaid/transactions/confirm-seeds
 *
 * Confirms the user's category selections from the "Quick Seed" interview.
 * For each confirmed seed:
 *   1. recordFeedback → updates Tier 1 in-memory cache + vector index (fire-and-forget)
 *   2. Promotes all matching CLASSIFIED PlaidTransactions:
 *      - Creates Transaction rows (USER_OVERRIDE, aiConfidence: 1.0)
 *      - Sets PlaidTransaction.promotionStatus = 'PROMOTED'
 *   3. seedHeld rows (Phase 1 hold-back): same promotion path for held-but-not-yet-staged rows
 *   4. Updates any already-PROMOTED rows' category (corrects auto-promotes that ran before confirm)
 *
 * After all seeds: fires TRANSACTIONS_IMPORTED event so analytics/portfolio recalculate.
 *
 * Body: {
 *   plaidItemId: string,
 *   seeds: [{ description: string, rawName?: string, confirmedCategoryId: number }]
 * }
 *
 * Auth: Cookie (withAuth middleware)
 */
export default withAuth(async function handler(req, res) {
    await new Promise((resolve, reject) => {
        const limiter = rateLimiters.plaidReview || rateLimiters.accounts;
        limiter(req, res, (result) => {
            if (result instanceof Error) return reject(result);
            resolve(result);
        });
    });

    if (cors(req, res)) return;

    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }

    try {
        const user = req.user;
        const { plaidItemId, seeds } = req.body || {};

        if (!plaidItemId) {
            return res.status(StatusCodes.BAD_REQUEST).json({ error: 'plaidItemId is required' });
        }
        if (!Array.isArray(seeds)) {
            return res.status(StatusCodes.BAD_REQUEST).json({ error: 'seeds array is required' });
        }

        // Verify the plaidItemId belongs to this tenant
        const plaidItem = await prisma.plaidItem.findFirst({
            where: { id: plaidItemId, tenantId: user.tenantId },
            select: { id: true },
        });
        if (!plaidItem) {
            return res.status(StatusCodes.NOT_FOUND).json({ error: 'Plaid item not found' });
        }

        // Validate all confirmedCategoryIds belong to this tenant
        const categoryIds = [...new Set(seeds.map(s => s.confirmedCategoryId).filter(Boolean))];
        const validCategories = categoryIds.length > 0
            ? await prisma.category.findMany({
                where: { id: { in: categoryIds }, tenantId: user.tenantId },
                select: { id: true, type: true, processingHint: true },
            })
            : [];
        const validCategoryIdSet = new Set(validCategories.map(c => c.id));
        const categoryById = new Map(validCategories.map(c => [c.id, c]));

        // Investment categories that require enrichment before promotion
        const MANDATORY_INVESTMENT_HINTS = ['API_STOCK', 'API_CRYPTO', 'API_FUND'];

        // Get all PlaidItem IDs for this tenant (scope for updateMany)
        const tenantPlaidItems = await prisma.plaidItem.findMany({
            where: { tenantId: user.tenantId },
            select: { id: true },
        });
        const tenantPlaidItemIds = tenantPlaidItems.map(pi => pi.id);

        // Pre-fetch all tenant accounts with plaidAccountId (needed for promotion)
        const tenantAccounts = await prisma.account.findMany({
            where: { tenantId: user.tenantId, plaidAccountId: { not: null } },
            select: { id: true, plaidAccountId: true },
        });
        const accountByPlaidId = new Map(tenantAccounts.map(a => [a.plaidAccountId, a]));

        console.log(`[confirm-seeds] Processing ${seeds.length} seed(s) for plaidItemId=${plaidItemId}, tenantId=${user.tenantId}`);
        console.log(`[confirm-seeds] Tenant PlaidItem IDs: [${tenantPlaidItemIds.join(', ')}]`);

        let confirmed = 0;
        let promoted = 0;
        const promotedAccountIds = new Set();
        let promotedMinYear = null;
        let promotedMinMonth = null;

        // ── Helper: promote a single PlaidTransaction ──────────────────────────
        async function promotePlaidTx(plaidTx, confirmedCategoryId) {
            // Check if the category requires investment enrichment (ticker/qty/price)
            const cat = categoryById.get(confirmedCategoryId);
            const needsEnrichment = cat &&
                cat.type === 'Investments' &&
                MANDATORY_INVESTMENT_HINTS.includes(cat.processingHint);

            if (needsEnrichment) {
                // Stage as CLASSIFIED with enrichment flag — user must fill in
                // ticker/quantity/price via the deep-dive drawer before promotion.
                await prisma.plaidTransaction.update({
                    where: { id: plaidTx.id },
                    data: {
                        suggestedCategoryId: confirmedCategoryId,
                        classificationSource: 'USER_OVERRIDE',
                        aiConfidence: 1.0,
                        promotionStatus: 'CLASSIFIED',
                        requiresEnrichment: true,
                        enrichmentType: 'INVESTMENT',
                        processed: true,
                        seedHeld: false,
                    },
                });
                return;
            }

            const localAccount = accountByPlaidId.get(plaidTx.plaidAccountId) ?? null;
            if (!localAccount) {
                // No linked account — stage as CLASSIFIED (not promoted). Will appear in review.
                await prisma.plaidTransaction.update({
                    where: { id: plaidTx.id },
                    data: {
                        suggestedCategoryId: confirmedCategoryId,
                        classificationSource: 'USER_OVERRIDE',
                        aiConfidence: 1.0,
                        promotionStatus: 'CLASSIFIED',
                        processed: true,
                        seedHeld: false,
                    },
                });
                return;
            }

            const txDate = new Date(plaidTx.date);
            const year = txDate.getFullYear();
            const month = txDate.getMonth() + 1;
            const day = txDate.getDate();
            const quarter = `Q${Math.ceil(month / 3)}`;
            const plaidAmount = Number(plaidTx.amount);
            const isDebit = plaidAmount > 0;
            const absAmount = Math.abs(plaidAmount);

            // Check if a Transaction row already exists (idempotent)
            const existing = await prisma.transaction.findUnique({
                where: { externalId: plaidTx.plaidTransactionId },
                select: { id: true },
            });

            if (!existing) {
                // Create Transaction row
                const newTx = await prisma.transaction.create({
                    data: {
                        transaction_date: txDate,
                        year, quarter, month, day,
                        categoryId: confirmedCategoryId,
                        description: plaidTx.merchantName || plaidTx.name,
                        details: plaidTx.name,
                        debit: isDebit ? absAmount : null,
                        credit: isDebit ? null : absAmount,
                        currency: plaidTx.isoCurrencyCode || 'USD',
                        accountId: localAccount.id,
                        tenantId: user.tenantId,
                        source: 'PLAID',
                        externalId: plaidTx.plaidTransactionId,
                    },
                });
                await prisma.plaidTransaction.update({
                    where: { id: plaidTx.id },
                    data: {
                        suggestedCategoryId: confirmedCategoryId,
                        classificationSource: 'USER_OVERRIDE',
                        aiConfidence: 1.0,
                        promotionStatus: 'PROMOTED',
                        matchedTransactionId: newTx.id,
                        processed: true,
                        seedHeld: false,
                    },
                });
            } else {
                // Transaction already exists — update its category + link PlaidTransaction
                await prisma.transaction.update({
                    where: { id: existing.id },
                    data: { categoryId: confirmedCategoryId },
                });
                await prisma.plaidTransaction.update({
                    where: { id: plaidTx.id },
                    data: {
                        suggestedCategoryId: confirmedCategoryId,
                        classificationSource: 'USER_OVERRIDE',
                        aiConfidence: 1.0,
                        promotionStatus: 'PROMOTED',
                        matchedTransactionId: existing.id,
                        processed: true,
                        seedHeld: false,
                    },
                });
            }

            promotedAccountIds.add(localAccount.id);
            if (!promotedMinYear || year < promotedMinYear) {
                promotedMinYear = year;
                promotedMinMonth = month;
            }
            promoted++;
        }

        // ── Process each seed ──────────────────────────────────────────────────
        for (const seed of seeds) {
            const { description, rawName, confirmedCategoryId } = seed;

            if (!description || !confirmedCategoryId) continue;
            if (!validCategoryIdSet.has(confirmedCategoryId)) continue;

            const matchName = rawName || description;
            console.log(`[confirm-seeds] Seed: description="${description}" rawName="${rawName}" matchName="${matchName}" categoryId=${confirmedCategoryId}`);

            // 1. Fire recordFeedback to update Tier 1 in-memory cache + vector index
            //    Fire-and-forget: don't block promotion on embedding generation
            fetch(`${BACKEND_URL}/api/feedback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': BACKEND_API_KEY,
                },
                body: JSON.stringify({
                    description,
                    categoryId: confirmedCategoryId,
                    tenantId: user.tenantId,
                }),
            }).catch(err => console.error(`[confirm-seeds] Feedback failed for "${description}": ${err.message}`));

            // 2a. Find CLASSIFIED rows for this description → promote them
            const classifiedTxs = await prisma.plaidTransaction.findMany({
                where: {
                    plaidItemId: { in: tenantPlaidItemIds },
                    name: matchName,
                    promotionStatus: 'CLASSIFIED',
                },
                select: {
                    id: true, plaidTransactionId: true, plaidAccountId: true,
                    name: true, merchantName: true, amount: true, date: true,
                    isoCurrencyCode: true,
                },
            });

            console.log(`[confirm-seeds]   → ${classifiedTxs.length} CLASSIFIED row(s) for "${matchName}"`);
            await Promise.all(classifiedTxs.map(plaidTx => promotePlaidTx(plaidTx, confirmedCategoryId)));
            confirmed += classifiedTxs.length;

            // 2b. Find seedHeld rows (Phase 1 hold-back) → promote them directly
            //     These were held before Phase 2 and are still PENDING.
            const heldTxs = await prisma.plaidTransaction.findMany({
                where: {
                    plaidItemId: { in: tenantPlaidItemIds },
                    name: matchName,
                    seedHeld: true,
                },
                select: {
                    id: true, plaidTransactionId: true, plaidAccountId: true,
                    name: true, merchantName: true, amount: true, date: true,
                    isoCurrencyCode: true,
                },
            });

            if (heldTxs.length > 0) {
                console.log(`[confirm-seeds]   → ${heldTxs.length} seedHeld row(s) to promote for "${matchName}"`);
                await Promise.all(heldTxs.map(plaidTx => promotePlaidTx(plaidTx, confirmedCategoryId)));
                confirmed += heldTxs.length;
            }

            // 2c. Update already-PROMOTED rows' category (corrects auto-promotes from Phase 1)
            //     Their Transaction rows also need updating.
            const alreadyPromotedTxs = await prisma.plaidTransaction.findMany({
                where: {
                    plaidItemId: { in: tenantPlaidItemIds },
                    name: matchName,
                    promotionStatus: 'PROMOTED',
                },
                select: { id: true, matchedTransactionId: true },
            });

            if (alreadyPromotedTxs.length > 0) {
                // Update Transaction category
                const txIds = alreadyPromotedTxs.map(t => t.matchedTransactionId).filter(Boolean);
                if (txIds.length > 0) {
                    await prisma.transaction.updateMany({
                        where: { id: { in: txIds } },
                        data: { categoryId: confirmedCategoryId },
                    });
                }
                // Update PlaidTransaction classification source
                await prisma.plaidTransaction.updateMany({
                    where: { id: { in: alreadyPromotedTxs.map(t => t.id) } },
                    data: {
                        suggestedCategoryId: confirmedCategoryId,
                        classificationSource: 'USER_OVERRIDE',
                        aiConfidence: 1.0,
                    },
                });
                console.log(`[confirm-seeds]   → corrected ${alreadyPromotedTxs.length} already-PROMOTED row(s) for "${matchName}"`);
            }
        }

        console.log(`[confirm-seeds] Done. confirmed=${confirmed}, promoted=${promoted}`);

        // 3. Release any remaining seedHeld rows for this plaidItem.
        //    promotePlaidTx() clears seedHeld on every confirmed seed, so only
        //    descriptions the user excluded (via X toggle) still have seedHeld=true.
        //    Setting them to CLASSIFIED surfaces them in the pending review queue
        //    with their AI suggestion (suggestedCategoryId/aiConfidence) already set.
        const released = await prisma.plaidTransaction.updateMany({
            where: { plaidItemId, seedHeld: true },
            data: { seedHeld: false, promotionStatus: 'CLASSIFIED' },
        });
        if (released.count > 0) {
            console.log(`[confirm-seeds] Released ${released.count} excluded seedHeld row(s) → CLASSIFIED (pending review)`);
        }

        // 4. Fire TRANSACTIONS_IMPORTED so analytics/portfolio recalculate
        if (promoted > 0 && promotedAccountIds.size > 0) {
            fetch(`${BACKEND_URL}/api/events`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': BACKEND_API_KEY,
                },
                body: JSON.stringify({
                    type: 'TRANSACTIONS_IMPORTED',
                    tenantId: user.tenantId,
                    accountIds: [...promotedAccountIds],
                    dateScope: { year: promotedMinYear, month: promotedMinMonth },
                    source: 'PLAID_SEED_CONFIRM',
                }),
            }).catch(err => console.error(`[confirm-seeds] TRANSACTIONS_IMPORTED event failed: ${err.message}`));
        }

        return res.status(StatusCodes.OK).json({ confirmed, promoted });
    } catch (error) {
        Sentry.captureException(error);
        console.error('Plaid confirm-seeds error:', error);
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'Server Error',
            ...(process.env.NODE_ENV === 'development' && { details: error.message }),
        });
    }
});
