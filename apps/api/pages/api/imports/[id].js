import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { produceEvent } from '../../../utils/produceEvent.js';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsRead(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  try {
    const user = req.user;

    const { id } = req.query;

    if (req.method === 'GET') {
      await handleGet(req, res, user, id);
    } else if (req.method === 'POST') {
      const action = req.query.action || req.body?.action;
      if (action === 'commit') {
        await handleCommit(req, res, user, id);
      } else if (action === 'cancel') {
        await handleCancel(req, res, user, id);
      } else {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'action query param required: "commit" or "cancel"' });
      }
    } else {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      details: error.message,
    });
  }
});

// ─── GET /api/imports/:id ────────────────────────────────────────────────────
// Returns the StagedImport with paginated rows, enriched with category names.

async function handleGet(req, res, user, stagedImportId) {
  const stagedImport = await prisma.stagedImport.findFirst({
    where: { id: stagedImportId, tenantId: user.tenantId },
  });

  if (!stagedImport) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'Import not found' });
  }

  // Pagination
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

  // status param: single value OR comma-separated list (e.g. "STAGED,POTENTIAL_DUPLICATE").
  // When no filter is supplied we DO NOT return the whole table — DUPLICATE and
  // SKIPPED rows are deliberately hidden so duplicate-flagged rows can never
  // reach the Review UI as committable. Callers that need to audit those rows
  // must opt in explicitly via ?status=DUPLICATE or ?status=SKIPPED.
  const DEFAULT_VISIBLE_STATUSES = ['PENDING', 'POTENTIAL_DUPLICATE', 'CONFIRMED', 'ERROR', 'STAGED'];
  const statusParam = req.query.status || null;
  const statusValues = statusParam
    ? statusParam.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_VISIBLE_STATUSES;
  const statusClause = statusValues.length === 1
    ? { status: statusValues[0] }
    : { status: { in: statusValues } };

  // Optional category filter (used by grouped view to paginate within a single category).
  // `uncategorized=true` is mutually exclusive with `categoryId` and matches rows where
  // suggestedCategoryId IS NULL — needed so the "Uncategorized" group is drillable.
  const uncategorizedFilter = req.query.uncategorized === 'true';
  const categoryIdFilter = !uncategorizedFilter && req.query.categoryId
    ? parseInt(req.query.categoryId, 10)
    : null;

  const categoryClause = uncategorizedFilter
    ? { suggestedCategoryId: null }
    : categoryIdFilter
      ? { suggestedCategoryId: categoryIdFilter }
      : {};

  const rowWhere = {
    stagedImportId,
    ...statusClause,
    ...categoryClause,
  };

  // Statuses that still need user action — used for the category breakdown summary.
  // Must match the effective status filter so grouped-view headers show the same
  // rows visible in the paginated list. DUPLICATE is excluded by default (see above).
  const pendingStatuses = statusValues;
  const pendingWhere = {
    stagedImportId,
    status: { in: pendingStatuses },
  };

  const [rows, total, statusCounts, earliestRow, categorySummaryRaw] = await Promise.all([
    prisma.stagedImportRow.findMany({
      where: rowWhere,
      orderBy: { rowNumber: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stagedImportRow.count({ where: rowWhere }),
    prisma.stagedImportRow.groupBy({
      by: ['status'],
      where: { stagedImportId },
      _count: { status: true },
    }),
    prisma.stagedImportRow.findFirst({
      where: { stagedImportId, transactionDate: { not: null } },
      orderBy: { transactionDate: 'asc' },
      select: { transactionDate: true },
    }),
    // Category breakdown across ALL pending rows regardless of pagination.
    // Drives grouped-view headers with accurate cross-page counts.
    prisma.stagedImportRow.groupBy({
      by: ['suggestedCategoryId'],
      where: pendingWhere,
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    }),
  ]);

  // Build statusSummary map { PENDING: N, CONFIRMED: N, ... }
  const statusSummary = Object.fromEntries(
    statusCounts.map(({ status, _count }) => [status, _count.status])
  );

  // Enrich rows with category names (union of row + summary category IDs to avoid a second query)
  const rowCategoryIds = rows.filter((r) => r.suggestedCategoryId).map((r) => r.suggestedCategoryId);
  const summaryCategoryIds = categorySummaryRaw
    .filter((s) => s.suggestedCategoryId != null)
    .map((s) => s.suggestedCategoryId);
  const allCategoryIds = [...new Set([...rowCategoryIds, ...summaryCategoryIds])];

  let categoryMap = {};
  if (allCategoryIds.length > 0) {
    const categories = await prisma.category.findMany({
      where: { id: { in: allCategoryIds } },
      select: { id: true, name: true, group: true, type: true },
    });
    categoryMap = Object.fromEntries(categories.map((c) => [c.id, c]));
  }

  const enrichedRows = rows.map((row) => ({
    ...row,
    suggestedCategory: row.suggestedCategoryId ? categoryMap[row.suggestedCategoryId] || null : null,
  }));

  // Build enriched category summary for grouped view
  const categorySummary = categorySummaryRaw.map((s) => ({
    categoryId: s.suggestedCategoryId,
    category: s.suggestedCategoryId ? categoryMap[s.suggestedCategoryId] || null : null,
    count: s._count.id,
  }));

  return res.status(StatusCodes.OK).json({
    import: {
      id: stagedImport.id,
      status: stagedImport.status,
      fileName: stagedImport.fileName,
      adapterName: stagedImport.adapterName,
      accountId: stagedImport.accountId,
      totalRows: stagedImport.totalRows,
      progress: stagedImport.progress ?? 0,
      errorCount: stagedImport.errorCount,
      errorDetails: stagedImport.errorDetails,
      autoConfirmedCount: stagedImport.autoConfirmedCount ?? null,
      updateCount: stagedImport.updateCount ?? 0,
      seedReady: stagedImport.seedReady ?? false,
      createdAt: stagedImport.createdAt,
      updatedAt: stagedImport.updatedAt,
      statusSummary,
      earliestTransactionDate: earliestRow?.transactionDate ?? null,
    },
    rows: enrichedRows,
    categorySummary,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

// ─── POST /api/imports/:id?action=commit ─────────────────────────────────────
// Promotes only CONFIRMED rows (with categories) to the Transaction table.
// PENDING and POTENTIAL_DUPLICATE rows remain staged for later review.

async function handleCommit(req, res, user, stagedImportId) {
  const stagedImport = await prisma.stagedImport.findFirst({
    where: { id: stagedImportId, tenantId: user.tenantId },
  });

  if (!stagedImport) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'Import not found' });
  }
  if (stagedImport.status !== 'READY') {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: `Import status is "${stagedImport.status}", expected "READY"`,
    });
  }

  // Transition to COMMITTING and reset progress for the commit phase
  await prisma.stagedImport.update({
    where: { id: stagedImportId },
    data: { status: 'COMMITTING', progress: 0 },
  });

  // Support partial commit: optional rowIds array in request body
  const { rowIds } = req.body || {};
  const isPartialCommit = Array.isArray(rowIds) && rowIds.length > 0;

  // Dispatch commit to the backend worker via event queue
  try {
    await produceEvent({
      type: 'SMART_IMPORT_COMMIT',
      tenantId: user.tenantId,
      userId: user.email,
      stagedImportId,
      ...(isPartialCommit && { rowIds }),
    });
  } catch (eventErr) {
    // If event dispatch fails, revert status so the user can retry
    await prisma.stagedImport.update({
      where: { id: stagedImportId },
      data: { status: 'READY', progress: 100 },
    });
    Sentry.captureException(eventErr);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to start commit process',
    });
  }

  return res.status(StatusCodes.ACCEPTED).json({
    status: 'COMMITTING',
    message: 'Commit process started. Poll for progress.',
  });
}

// ─── POST /api/imports/:id?action=cancel ─────────────────────────────────────
// Marks the import as CANCELLED. No rows are promoted.

async function handleCancel(req, res, user, stagedImportId) {
  const stagedImport = await prisma.stagedImport.findFirst({
    where: { id: stagedImportId, tenantId: user.tenantId },
  });

  if (!stagedImport) {
    return res.status(StatusCodes.NOT_FOUND).json({ error: 'Import not found' });
  }
  if (stagedImport.status === 'COMMITTED') {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Cannot cancel a committed import' });
  }

  // Delete staged rows and mark import as cancelled in a single transaction
  await prisma.$transaction([
    prisma.stagedImportRow.deleteMany({
      where: { stagedImportId },
    }),
    prisma.stagedImport.update({
      where: { id: stagedImportId },
      data: { status: 'CANCELLED' },
    }),
  ]);

  return res.status(StatusCodes.OK).json({ cancelled: true });
}
