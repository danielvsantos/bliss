import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../utils/withAuth.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

/**
 * POST /api/imports/:id/confirm-seeds
 *
 * Confirms the user's category selections from the Quick Seed interview
 * before the main import review table.
 * For each seed:
 *   1. Fires recordFeedback to the backend (updates in-memory cache + vector index)
 *   2. Updates all matching PENDING/CONFIRMED StagedImportRows to the confirmed category
 *
 * Body: {
 *   seeds: [{ description: string, confirmedCategoryId: number }]
 * }
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

    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }

    try {
        const user = req.user;
        const { id: stagedImportId } = req.query;
        const { seeds } = req.body || {};

        if (!Array.isArray(seeds) || seeds.length === 0) {
            return res.status(StatusCodes.BAD_REQUEST).json({ error: 'seeds array is required and must not be empty' });
        }

        // Verify the import belongs to this tenant
        const stagedImport = await prisma.stagedImport.findFirst({
            where: { id: stagedImportId, tenantId: user.tenantId },
            select: { id: true },
        });

        if (!stagedImport) {
            return res.status(StatusCodes.NOT_FOUND).json({ error: 'Import not found' });
        }

        // Validate all confirmedCategoryIds belong to this tenant
        const categoryIds = [...new Set(seeds.map(s => s.confirmedCategoryId).filter(Boolean))];
        const validCategories = categoryIds.length > 0
            ? await prisma.category.findMany({
                where: { id: { in: categoryIds }, tenantId: user.tenantId },
                select: { id: true },
            })
            : [];
        const validCategoryIdSet = new Set(validCategories.map(c => c.id));

        let confirmed = 0;

        await Promise.all(seeds.map(async (seed) => {
            const { description, confirmedCategoryId } = seed;

            if (!description || !confirmedCategoryId) return;
            if (!validCategoryIdSet.has(confirmedCategoryId)) return;

            // 1. Fire recordFeedback to update in-memory cache + vector index
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
            }).catch(err => console.error(`[import confirm-seeds] Feedback failed for "${description}": ${err.message}`));

            // 2. Update all matching PENDING/CONFIRMED rows to the confirmed category
            const { count } = await prisma.stagedImportRow.updateMany({
                where: {
                    stagedImportId,
                    description,
                    status: { in: ['PENDING', 'CONFIRMED'] },
                },
                data: {
                    suggestedCategoryId: confirmedCategoryId,
                    classificationSource: 'USER_OVERRIDE',
                    confidence: 1.0,
                    status: 'CONFIRMED',
                },
            });

            confirmed += count;
        }));

        return res.status(StatusCodes.OK).json({ confirmed });
    } catch (error) {
        Sentry.captureException(error);
        console.error('Import confirm-seeds error:', error);
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'Server Error',
            ...(process.env.NODE_ENV === 'development' && { details: error.message }),
        });
    }
});
