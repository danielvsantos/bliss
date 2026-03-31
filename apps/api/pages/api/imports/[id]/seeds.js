import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../utils/withAuth.js';

/**
 * GET /api/imports/:id/seeds?limit=15
 *
 * Returns the top N distinct descriptions (by frequency) that were classified
 * by the LLM during Phase 1 of the Smart Import processing. Used to populate
 * the "Quick Seed" interview before the main review table.
 *
 * Only LLM-classified rows are returned — EXACT_MATCH and VECTOR_MATCH rows
 * are already known and don't need user confirmation.
 *
 * Auth: Cookie (withAuth middleware)
 */
export default withAuth(async function handler(req, res) {
    await new Promise((resolve, reject) => {
        const limiter = rateLimiters.importsRead || rateLimiters.common;
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
        const { id: stagedImportId } = req.query;
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));

        // Verify the import belongs to this tenant
        const stagedImport = await prisma.stagedImport.findFirst({
            where: { id: stagedImportId, tenantId: user.tenantId },
            select: { id: true },
        });

        if (!stagedImport) {
            return res.status(StatusCodes.NOT_FOUND).json({ error: 'Import not found' });
        }

        // Fetch LLM-classified rows (PENDING or CONFIRMED — both can appear in the interview)
        const llmRows = await prisma.stagedImportRow.findMany({
            where: {
                stagedImportId,
                classificationSource: 'LLM',
                status: { in: ['PENDING', 'CONFIRMED'] },
                description: { not: null },
                suggestedCategoryId: { not: null },
            },
            select: {
                id: true,
                description: true,
                suggestedCategoryId: true,
                confidence: true,
                classificationSource: true,
            },
        });

        if (llmRows.length === 0) {
            return res.status(StatusCodes.OK).json([]);
        }

        // Group by normalized description, count frequency
        const normalize = (desc) => (desc || '').toLowerCase().trim().replace(/\s+/g, ' ');
        const freqMap = new Map();

        for (const row of llmRows) {
            const key = normalize(row.description);
            if (!freqMap.has(key)) {
                freqMap.set(key, {
                    normalizedDescription: key,
                    description: row.description,
                    count: 0,
                    suggestedCategoryId: row.suggestedCategoryId,
                    confidence: row.confidence,
                    classificationSource: row.classificationSource,
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
            count: s.count,
            suggestedCategoryId: s.suggestedCategoryId,
            suggestedCategoryName: s.suggestedCategoryId
                ? catMap.get(s.suggestedCategoryId)?.name || null
                : null,
            suggestedCategory: s.suggestedCategoryId
                ? catMap.get(s.suggestedCategoryId) || null
                : null,
            aiConfidence: s.confidence,
            classificationSource: s.classificationSource,
        }));

        return res.status(StatusCodes.OK).json(seeds);
    } catch (error) {
        Sentry.captureException(error);
        console.error('Import seeds error:', error);
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'Server Error',
            ...(process.env.NODE_ENV === 'development' && { details: error.message }),
        });
    }
});
