import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { produceEvent } from '../../../utils/produceEvent.js';
import { eventOrigin } from '../../../utils/eventOrigin.js';
import { withAuth } from '../../../utils/withAuth.js';
import { fetchWithTimeout } from '../../../utils/fetchWithTimeout.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

const BULK_MAX_IDS = 50;

// Moving a row into or out of these needs ticker / quantity / price per row and
// changes portfolio holdings, so it stays a single-row edit (update_transaction).
const PORTFOLIO_TYPES = new Set(['Investments', 'Debt']);

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

function badRequest(res, code, error, extra = {}) {
  res.status(StatusCodes.BAD_REQUEST).json({ error, code, ...extra });
}

/**
 * PATCH /api/transactions/bulk (#141)
 *
 * Recategorise up to 50 committed transactions in one all-or-nothing call.
 * Body: `{ ids: number[], categoryId: number }`.
 * Returns 200 `{ updated: number[], unchanged: number[] }`.
 *
 * Every check runs before any write. Tenant scope is the ownership check, as
 * for PUT /api/transactions (#90): an ID from another tenant is reported as
 * not found, exactly like one that doesn't exist, and its row is never read.
 *
 * Only rows whose category actually changes are written, train the classifier
 * and reach analytics. The whole call emits ONE event, so N rows settle in one
 * analytics refresh instead of N.
 */
export default withAuth(async function handler(req, res) {
  // Same limiter as /api/transactions: one bulk call counts as one request.
  await new Promise((resolve, reject) => {
    rateLimiters.transactions(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'PATCH') {
    res.setHeader('Allow', ['PATCH']);
    res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    return;
  }

  try {
    await handlePatch(req, res);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to update transactions',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

async function handlePatch(req, res) {
  const { tenantId, email: userId } = req.user;
  const { ids, categoryId } = req.body || {};

  // 1. Body shape.
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_MAX_IDS) {
    return badRequest(res, 'INVALID_BODY', `ids must be an array of 1 to ${BULK_MAX_IDS} transaction IDs.`);
  }
  if (!ids.every(isPositiveInt)) {
    return badRequest(res, 'INVALID_BODY', 'ids must contain positive integer transaction IDs.');
  }
  if (new Set(ids).size !== ids.length) {
    return badRequest(res, 'INVALID_BODY', 'ids must not contain duplicates.');
  }
  if (!isPositiveInt(categoryId)) {
    return badRequest(res, 'INVALID_BODY', 'categoryId must be a positive integer.');
  }

  // 2–3. Target category: in this tenant, and not a portfolio category.
  const category = await prisma.category.findFirst({ where: { id: categoryId, tenantId } });
  if (!category) {
    return badRequest(res, 'CATEGORY_NOT_FOUND', 'Category not found in this tenant.');
  }
  if (PORTFOLIO_TYPES.has(category.type)) {
    return badRequest(
      res,
      'CATEGORY_NOT_ALLOWED',
      `Bulk recategorisation cannot move transactions into ${category.type} categories; use update_transaction / PUT /api/transactions per row.`,
    );
  }

  // 4. Rows, tenant-scoped: a foreign ID simply isn't found.
  const rows = await prisma.transaction.findMany({
    where: { id: { in: ids }, tenantId },
    select: {
      id: true,
      categoryId: true,
      description: true,
      year: true,
      month: true,
      account: { select: { countryId: true } },
      category: { select: { type: true, group: true } },
    },
  });
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    res.status(StatusCodes.NOT_FOUND).json({
      error: `Transactions not found in this tenant: ${missing.join(', ')}`,
      code: 'TRANSACTIONS_NOT_FOUND',
      ids: missing,
    });
    return;
  }

  // 5. Rows currently in a portfolio category.
  const portfolioRows = rows.filter((r) => PORTFOLIO_TYPES.has(r.category?.type)).map((r) => r.id);
  if (portfolioRows.length > 0) {
    return badRequest(
      res,
      'ROWS_NOT_ALLOWED',
      `Transactions in Investments or Debt categories cannot be bulk recategorised: ${portfolioRows.join(', ')}`,
      { ids: portfolioRows },
    );
  }

  // 6–7. Split; nothing to do means no write, no feedback, no events.
  // In request order, so the response lists IDs the way the caller sent them.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id));
  const changed = ordered.filter((r) => r.categoryId !== categoryId);
  const unchanged = ordered.filter((r) => r.categoryId === categoryId).map((r) => r.id);
  if (changed.length === 0) {
    res.status(StatusCodes.OK).json({ updated: [], unchanged });
    return;
  }
  const changedIds = changed.map((r) => r.id);

  // 8. Atomic write. A row deleted since step 4 makes the count short: throw,
  // roll back, nothing written.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.transaction.updateMany({
      where: { id: { in: changedIds }, tenantId },
      data: { categoryId, userId },
    });
    if (count !== changedIds.length) {
      throw new Error(`Bulk recategorise wrote ${count} of ${changedIds.length} rows; rolled back.`);
    }
  });

  // 9a. Classifier feedback per changed row, as a single PUT gives it
  // (DescriptionMapping write-through + embedding). Fire-and-forget.
  const feedbackEntries = changed
    .filter((r) => r.description)
    .map((r) => ({ description: r.description, categoryId, transactionId: r.id }));
  if (feedbackEntries.length > 0) {
    fetchWithTimeout(`${BACKEND_URL}/api/feedback/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': BACKEND_API_KEY },
      body: JSON.stringify({ tenantId, entries: feedbackEntries }),
    }, 25000).catch((err) => {
      console.warn(`Bulk recategorise batch feedback error: ${err.message}`);
      if (err.name !== 'AbortError') {
        Sentry.captureException(err, { extra: { eventType: 'feedback-batch', count: feedbackEntries.length } });
      }
    });
  }

  // 9b. ONE event for the whole call. TAG_ASSIGNMENT_MODIFIED is the backend's
  // "scoped analytics refresh" event: the scheduler only reads `tenantId` and
  // `transactionScopes`, and the analytics worker recomputes regular and tag
  // analytics in one pass. A category change touches neither cash holdings
  // nor the portfolio (portfolio categories are refused above), so the heavier
  // MANUAL_TRANSACTION_MODIFIED chain would be wasted work. Do not turn this
  // into a per-row loop. Scopes carry no `currency`: an analytics slice can be
  // fed by several native currencies, and an unconstrained scope lets the
  // worker recompute (or clear) the whole slice.
  const scopes = new Map();
  const addScope = (r, type, group) => {
    const scope = { year: r.year, month: r.month, country: r.account?.countryId, type, group };
    scopes.set(JSON.stringify(scope), scope);
  };
  for (const r of changed) {
    addScope(r, r.category?.type, r.category?.group); // old slice
    addScope(r, category.type, category.group); // new slice
  }
  await produceEvent({
    ...eventOrigin(req),
    type: 'TAG_ASSIGNMENT_MODIFIED',
    tenantId,
    transactionScopes: [...scopes.values()],
  });

  res.status(StatusCodes.OK).json({ updated: changedIds, unchanged });
}
