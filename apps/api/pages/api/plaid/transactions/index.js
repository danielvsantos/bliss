import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { cors } from '../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../utils/withAuth.js';

/**
 * GET /api/plaid/transactions
 *
 * Lists PlaidTransactions for the tenant that need review.
 * Supports pagination and filtering by promotionStatus, plaidItemId, confidence range.
 *
 * Query params:
 *   page (default 1), limit (default 50, max 200)
 *   promotionStatus - PENDING | CLASSIFIED | PROMOTED | SKIPPED (default: CLASSIFIED)
 *   plaidItemId - filter by specific Plaid connection
 *   minConfidence - float 0-1
 *   maxConfidence - float 0-1
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

    // Parse query params
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const promotionStatus = req.query.promotionStatus || 'CLASSIFIED';
    const plaidItemId = req.query.plaidItemId || null;
    const minConfidence = req.query.minConfidence ? parseFloat(req.query.minConfidence) : null;
    const maxConfidence = req.query.maxConfidence ? parseFloat(req.query.maxConfidence) : null;

    // First, get all plaidItemIds belonging to this tenant
    const tenantPlaidItems = await prisma.plaidItem.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true },
    });
    const tenantPlaidItemIds = tenantPlaidItems.map((pi) => pi.id);

    if (tenantPlaidItemIds.length === 0) {
      return res.status(StatusCodes.OK).json({
        transactions: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        summary: { classified: 0, pending: 0, promoted: 0, skipped: 0 },
      });
    }

    // Build where clause
    // Optional category filter (used by grouped view to paginate within a single category).
    // `uncategorized=true` is mutually exclusive with `categoryId` and matches rows where
    // suggestedCategoryId IS NULL — needed so the "Uncategorized" group is drillable.
    const uncategorizedParam = req.query.uncategorized === 'true';
    const categoryIdParam = !uncategorizedParam && req.query.categoryId
      ? parseInt(req.query.categoryId, 10)
      : null;

    const where = {
      plaidItemId: plaidItemId
        ? { in: tenantPlaidItemIds.includes(plaidItemId) ? [plaidItemId] : [] }
        : { in: tenantPlaidItemIds },
    };

    // Filter by promotionStatus
    if (promotionStatus !== 'ALL') {
      where.promotionStatus = promotionStatus;
    }

    // Filter by confidence range
    if (minConfidence !== null || maxConfidence !== null) {
      where.aiConfidence = {};
      if (minConfidence !== null) where.aiConfidence.gte = minConfidence;
      if (maxConfidence !== null) where.aiConfidence.lte = maxConfidence;
    }

    // Optional category filter
    if (uncategorizedParam) {
      where.suggestedCategoryId = null;
    } else if (categoryIdParam) {
      where.suggestedCategoryId = categoryIdParam;
    }

    // Fetch transactions and count
    const [transactions, total] = await Promise.all([
      prisma.plaidTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          plaidItemId: true,
          plaidAccountId: true,
          plaidTransactionId: true,
          amount: true,
          date: true,
          authorizedDate: true,
          name: true,
          merchantName: true,
          paymentChannel: true,
          isoCurrencyCode: true,
          pending: true,
          category: true,
          syncType: true,
          processed: true,
          processingError: true,
          matchedTransactionId: true,
          suggestedCategoryId: true,
          aiConfidence: true,
          classificationSource: true,
          promotionStatus: true,
          requiresEnrichment: true,
          enrichmentType: true,
          createdAt: true,
          updatedAt: true,
          plaidItem: {
            select: {
              institutionName: true,
            },
          },
        },
      }),
      prisma.plaidTransaction.count({ where }),
    ]);

    // Get summary counts — scoped to the same plaidItemId filter as the transaction query
    const summaryPlaidIds = plaidItemId && tenantPlaidItemIds.includes(plaidItemId)
      ? [plaidItemId]
      : tenantPlaidItemIds;
    const summaryWhere = { plaidItemId: { in: summaryPlaidIds } };
    const [classifiedCount, pendingCount, promotedCount, skippedCount, seedHeldCount, categoryBreakdownRaw] = await Promise.all([
      prisma.plaidTransaction.count({ where: { ...summaryWhere, promotionStatus: 'CLASSIFIED' } }),
      prisma.plaidTransaction.count({ where: { ...summaryWhere, promotionStatus: 'PENDING', seedHeld: false } }),
      prisma.plaidTransaction.count({ where: { ...summaryWhere, promotionStatus: 'PROMOTED' } }),
      prisma.plaidTransaction.count({ where: { ...summaryWhere, promotionStatus: 'SKIPPED' } }),
      prisma.plaidTransaction.count({ where: { ...summaryWhere, seedHeld: true } }),
      // Category breakdown across ALL CLASSIFIED transactions (not just the current page).
      // Drives grouped-view headers with accurate cross-page counts.
      prisma.plaidTransaction.groupBy({
        by: ['suggestedCategoryId'],
        where: { ...summaryWhere, promotionStatus: 'CLASSIFIED' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
    ]);

    // Enrich with category names (union of page rows + breakdown IDs to avoid a second query)
    const pageCategoryIds = transactions.map((t) => t.suggestedCategoryId).filter(Boolean);
    const breakdownCategoryIds = categoryBreakdownRaw
      .filter((s) => s.suggestedCategoryId != null)
      .map((s) => s.suggestedCategoryId);
    const allCategoryIds = [...new Set([...pageCategoryIds, ...breakdownCategoryIds])];

    const cats = allCategoryIds.length > 0
      ? await prisma.category.findMany({
          where: { id: { in: allCategoryIds }, tenantId: user.tenantId },
          select: { id: true, name: true, group: true, type: true },
        })
      : [];
    const catMap = new Map(cats.map((c) => [c.id, c]));

    const categoryBreakdown = categoryBreakdownRaw.map((s) => ({
      categoryId: s.suggestedCategoryId,
      category: s.suggestedCategoryId ? catMap.get(s.suggestedCategoryId) || null : null,
      count: s._count.id,
    }));

    // Enrich with account names (Plaid accounts linked to local accounts)
    const plaidAccountIds = [...new Set(transactions.map((t) => t.plaidAccountId))];
    const linkedAccounts = plaidAccountIds.length > 0
      ? await prisma.account.findMany({
          where: { plaidAccountId: { in: plaidAccountIds }, tenantId: user.tenantId },
          select: { plaidAccountId: true, name: true },
        })
      : [];
    const accountMap = new Map(linkedAccounts.map((a) => [a.plaidAccountId, a.name]));

    const enrichedTransactions = transactions.map((t) => ({
      ...t,
      suggestedCategory: t.suggestedCategoryId ? catMap.get(t.suggestedCategoryId) || null : null,
      accountName: accountMap.get(t.plaidAccountId) || null,
      institutionName: t.plaidItem?.institutionName || null,
      plaidItem: undefined, // Remove the nested relation
    }));

    res.status(StatusCodes.OK).json({
      transactions: enrichedTransactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        classified: classifiedCount,
        pending: pendingCount,
        promoted: promotedCount,
        skipped: skippedCount,
        seedHeld: seedHeldCount,
        categoryBreakdown,
      },
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Plaid transactions list error:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
