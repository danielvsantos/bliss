import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { cors } from '../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../utils/withAuth.js';

/**
 * POST /api/imports/:id/bulk-confirm
 *
 * Bulk-confirms staged rows in a single round-trip — replaces the legacy
 * client-side fan-out (50 parallel PUTs) that triggered 429 rate limits when
 * users hit "Approve All" on a category that spanned multiple pages.
 *
 * Body (mutually exclusive — at most one filter): {
 *   categoryId?: number     // confirm rows with suggestedCategoryId === categoryId
 *   uncategorized?: boolean // confirm rows with suggestedCategoryId IS NULL
 * }
 *
 * Excluded rows (skipped silently — must be reviewed individually via the drawer):
 * - status NOT IN ('PENDING','ERROR','STAGED')  // CONFIRMED, SKIPPED, DUPLICATE, POTENTIAL_DUPLICATE
 * - requiresEnrichment === true                 // investments missing ticker/qty/price
 *
 * Returns: { confirmed: number }
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsRead(req, res, (result) => {
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

    const stagedImport = await prisma.stagedImport.findFirst({
      where: { id: stagedImportId, tenantId: user.tenantId },
      select: { id: true, status: true },
    });
    if (!stagedImport) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Import not found' });
    }
    if (stagedImport.status === 'COMMITTED' || stagedImport.status === 'CANCELLED') {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: `Cannot bulk-confirm rows of a ${stagedImport.status.toLowerCase()} import`,
      });
    }

    const { categoryId, uncategorized } = req.body || {};
    const wantsUncategorized = uncategorized === true;
    const parsedCategoryId = !wantsUncategorized && categoryId != null
      ? parseInt(categoryId, 10)
      : null;

    if (parsedCategoryId !== null && Number.isNaN(parsedCategoryId)) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid categoryId' });
    }

    const categoryClause = wantsUncategorized
      ? { suggestedCategoryId: null }
      : parsedCategoryId !== null
        ? { suggestedCategoryId: parsedCategoryId }
        : {};

    const result = await prisma.stagedImportRow.updateMany({
      where: {
        stagedImportId,
        status: { in: ['PENDING', 'ERROR', 'STAGED'] },
        // POTENTIAL_DUPLICATE is intentionally excluded — those rows must be
        // approved one-by-one via the drawer; bulk-approving would silently
        // commit re-imported transactions the user never examined.
        requiresEnrichment: { not: true },
        ...categoryClause,
      },
      data: { status: 'CONFIRMED' },
    });

    return res.status(StatusCodes.OK).json({ confirmed: result.count });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      details: error.message,
    });
  }
});
