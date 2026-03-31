import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../utils/withAuth.js';

/**
 * GET /api/plaid/transactions/seeds?plaidItemId=<id>&limit=15
 *
 * Returns the top N distinct descriptions (by frequency) that were held back
 * during Phase 1 of the initial sync. Used to populate the "Quick Seed"
 * interview in the account-selection-modal.
 *
 * Returns all rows where seedHeld=true, regardless of classificationSource.
 * This includes:
 *   - LLM-classified rows (classificationSource='LLM')
 *   - Vector-matched rows below the auto-promote threshold
 *     (classificationSource='VECTOR_MATCH' or 'VECTOR_MATCH_GLOBAL')
 *
 * EXACT_MATCH rows and any result at or above autoPromoteThreshold are never
 * held — they are processed immediately without user review.
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

    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }

    try {
        const user = req.user;
        const { plaidItemId } = req.query;
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));

        if (!plaidItemId) {
            return res.status(StatusCodes.BAD_REQUEST).json({ error: 'plaidItemId is required' });
        }

        // Verify the plaidItemId belongs to this tenant
        const plaidItem = await prisma.plaidItem.findFirst({
            where: { id: plaidItemId, tenantId: user.tenantId },
            select: { id: true },
        });

        if (!plaidItem) {
            return res.status(StatusCodes.NOT_FOUND).json({ error: 'Plaid item not found' });
        }

        // Fetch all held transactions for this plaid item.
        // seedHeld=true covers LLM, VECTOR_MATCH, and VECTOR_MATCH_GLOBAL rows
        // that were held back because confidence < autoPromoteThreshold.
        // EXACT_MATCH and high-confidence results never reach this query.
        const llmTransactions = await prisma.plaidTransaction.findMany({
            where: {
                plaidItemId,
                seedHeld: true,
            },
            select: {
                id: true,
                name: true,
                merchantName: true,
                suggestedCategoryId: true,
                aiConfidence: true,
                classificationSource: true,
                classificationReasoning: true,
                category: true,
            },
            orderBy: { createdAt: 'asc' },
        });

        if (llmTransactions.length === 0) {
            return res.status(StatusCodes.OK).json([]);
        }

        // Group by normalized description, count frequency
        const normalize = (name) => (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
        const freqMap = new Map();

        for (const tx of llmTransactions) {
            const key = normalize(tx.name);
            if (!freqMap.has(key)) {
                freqMap.set(key, {
                    normalizedDescription: key,
                    description: tx.merchantName || tx.name,
                    rawName: tx.name,
                    count: 0,
                    suggestedCategoryId: tx.suggestedCategoryId,
                    aiConfidence: tx.aiConfidence,
                    classificationSource: tx.classificationSource,
                    classificationReasoning: tx.classificationReasoning,
                    // Extract the primary Plaid hint from personal_finance_category JSON
                    plaidHint: tx.category?.primary || null,
                });
            }
            freqMap.get(key).count++;
        }

        // Sort by frequency DESC, take top N
        const sorted = [...freqMap.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);

        // Enrich with category names
        const categoryIds = [...new Set(sorted.map(s => s.suggestedCategoryId).filter(Boolean))];
        const categories = categoryIds.length > 0
            ? await prisma.category.findMany({
                where: { id: { in: categoryIds }, tenantId: user.tenantId },
                select: { id: true, name: true, group: true, type: true },
            })
            : [];
        const catMap = new Map(categories.map(c => [c.id, c]));

        const seeds = sorted.map(s => ({
            description: s.description,
            normalizedDescription: s.normalizedDescription,
            rawName: s.rawName,
            count: s.count,
            suggestedCategoryId: s.suggestedCategoryId,
            suggestedCategoryName: s.suggestedCategoryId
                ? catMap.get(s.suggestedCategoryId)?.name || null
                : null,
            suggestedCategory: s.suggestedCategoryId
                ? catMap.get(s.suggestedCategoryId) || null
                : null,
            aiConfidence: s.aiConfidence,
            classificationSource: s.classificationSource,
            classificationReasoning: s.classificationReasoning,
            plaidHint: s.plaidHint,
        }));

        return res.status(StatusCodes.OK).json(seeds);
    } catch (error) {
        Sentry.captureException(error);
        console.error('Plaid seeds error:', error);
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'Server Error',
            ...(process.env.NODE_ENV === 'development' && { details: error.message }),
        });
    }
});
