import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { cors } from '../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { produceEvent } from '../../../../utils/produceEvent.js';
import { withAuth } from '../../../../utils/withAuth.js';
import { computeTransactionHash, buildDuplicateHashSet } from '../../../../utils/transactionHash.js';
import { fetchWithTimeout } from '../../../../utils/fetchWithTimeout.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;


/**
 * POST /api/plaid/transactions/bulk-promote
 *
 * Promotes all CLASSIFIED PlaidTransactions that meet the confidence threshold.
 * Only promotes transactions that have a suggestedCategoryId and a linked local account.
 *
 * Uses batch operations (createMany + updateMany) instead of per-row interactive
 * transactions to avoid exhausting the Prisma connection pool on large batches.
 *
 * Body: {
 *   minConfidence?: number (default 0.8),
 *   plaidItemId?: string (optional filter),
 *   categoryId?: number (optional filter by category),
 *   transactionIds?: string[] (optional explicit IDs — bypasses confidence gate),
 *   overrideCategoryId?: number (override category for all promoted transactions),
 * }
 *
 * Returns: { promoted: number, skipped: number, errors: number }
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

    const transactionIdsFilter = req.body.transactionIds || null;
    // When explicit IDs are provided the user has deliberately chosen those rows —
    // bypass the confidence gate. Confidence threshold only applies to unfiltered bulk ops.
    const minConfidence = transactionIdsFilter?.length > 0
      ? 0
      : (req.body.minConfidence ?? 0.8);
    const plaidItemIdFilter = req.body.plaidItemId || null;
    const categoryIdFilter = req.body.categoryId || null;
    // overrideCategoryId: when set, every promoted transaction gets this category applied,
    // regardless of its existing suggestedCategoryId (used by drawer "promote-all" flow).
    const overrideCategoryId = req.body.overrideCategoryId
      ? parseInt(req.body.overrideCategoryId)
      : null;

    // ── Parallel setup: category validation + plaid items + linked accounts ──
    const [overrideCat, tenantPlaidItems, linkedAccounts] = await Promise.all([
      overrideCategoryId
        ? prisma.category.findFirst({
            where: { id: overrideCategoryId, tenantId: user.tenantId },
            select: { id: true },
          })
        : Promise.resolve(true), // no validation needed
      prisma.plaidItem.findMany({
        where: { tenantId: user.tenantId },
        select: { id: true },
      }),
      prisma.account.findMany({
        where: { tenantId: user.tenantId, plaidAccountId: { not: null } },
        select: { id: true, plaidAccountId: true },
      }),
    ]);

    // Validate overrideCategoryId belongs to this tenant
    if (overrideCategoryId && !overrideCat) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid category' });
    }

    const tenantPlaidItemIds = tenantPlaidItems.map((pi) => pi.id);

    if (tenantPlaidItemIds.length === 0) {
      return res.status(StatusCodes.OK).json({ promoted: 0, skipped: 0, errors: 0 });
    }

    const accountMap = new Map(linkedAccounts.map((a) => [a.plaidAccountId, a.id]));

    // Fetch all eligible transactions
    const where = {
      plaidItemId: plaidItemIdFilter
        ? { in: tenantPlaidItemIds.includes(plaidItemIdFilter) ? [plaidItemIdFilter] : [] }
        : { in: tenantPlaidItemIds },
      promotionStatus: 'CLASSIFIED',
      // When overriding the category we don't require an existing suggestedCategoryId —
      // the override will supply the category for every transaction in the batch.
      ...(!overrideCategoryId && { suggestedCategoryId: { not: null } }),
      aiConfidence: { gte: minConfidence },
      requiresEnrichment: false,
      ...(categoryIdFilter && { suggestedCategoryId: categoryIdFilter }),
      ...(transactionIdsFilter && Array.isArray(transactionIdsFilter) && { id: { in: transactionIdsFilter } }),
    };

    const eligibleTransactions = await prisma.plaidTransaction.findMany({
      where,
      orderBy: { date: 'desc' },
    });

    let promoted = 0;
    let skipped = 0;
    let errors = 0;
    const affectedAccountIds = new Set();
    const affectedDateScopes = new Set();

    // ── Phase 1: Parallel dedup lookups ──────────────────────────────────────
    const allExternalIds = eligibleTransactions.map((t) => t.plaidTransactionId);

    const uniqueLocalAccountIds = new Set();
    for (const plaidTx of eligibleTransactions) {
      const localId = accountMap.get(plaidTx.plaidAccountId);
      if (localId) uniqueLocalAccountIds.add(localId);
    }
    // Compute date range from eligible transactions to narrow dedup query
    const allDates = eligibleTransactions.map(t => new Date(t.date)).filter(d => !isNaN(d.getTime()));
    const minDate = allDates.length > 0 ? new Date(Math.min(...allDates.map(d => d.getTime()))) : null;
    const maxDate = allDates.length > 0 ? new Date(Math.max(...allDates.map(d => d.getTime()))) : null;

    const accountIdArr = Array.from(uniqueLocalAccountIds);
    const [existingTransactions, ...hashSetsArr] = await Promise.all([
      prisma.transaction.findMany({
        where: { externalId: { in: allExternalIds } },
        select: { id: true, externalId: true },
      }),
      ...accountIdArr.map((accountId) =>
        buildDuplicateHashSet(user.tenantId, accountId, minDate, maxDate)
      ),
    ]);
    const existingByExternalId = new Map(existingTransactions.map((t) => [t.externalId, t.id]));
    const hashSetByAccountId = new Map(
      accountIdArr.map((id, i) => [id, hashSetsArr[i]])
    );

    // ── Phase 2: Classify each transaction (no DB writes) ─────────────────
    const alreadyExisting = [];   // { plaidTx, existingTxId } — link only, no new Transaction
    const hashDuplicateIds = [];  // plaidTx.id[] — mark as DUPLICATE
    const toCreate = [];          // { plaidTx, transactionData } — need new Transaction records

    for (const plaidTx of eligibleTransactions) {
      const localAccountId = accountMap.get(plaidTx.plaidAccountId);
      if (!localAccountId) { skipped++; continue; }

      const effectiveCategoryId = overrideCategoryId ?? plaidTx.suggestedCategoryId;
      if (!effectiveCategoryId) { skipped++; continue; }

      // Check externalId dedup
      const existingId = existingByExternalId.get(plaidTx.plaidTransactionId);
      if (existingId) {
        alreadyExisting.push({ plaidTx, existingTxId: existingId });
        continue;
      }

      // Check hash-based dedup
      const plaidAmount = Number(plaidTx.amount);
      const absAmountForHash = Math.abs(plaidAmount);
      const txDate = new Date(plaidTx.date);
      const hashSet = hashSetByAccountId.get(localAccountId);
      if (hashSet) {
        const hash = computeTransactionHash(
          txDate,
          plaidTx.merchantName || plaidTx.name,
          absAmountForHash,
          localAccountId,
        );
        if (hashSet.has(hash)) {
          hashDuplicateIds.push(plaidTx.id);
          continue;
        }
      }

      // Prepare Transaction data for batch insert
      const isDebit = plaidAmount > 0;
      const absAmount = Math.abs(plaidAmount);
      const year = txDate.getFullYear();
      const month = txDate.getMonth() + 1;
      const day = txDate.getDate();
      const quarter = `Q${Math.ceil(month / 3)}`;

      toCreate.push({
        plaidTx,
        transactionData: {
          transaction_date: txDate,
          year,
          quarter,
          month,
          day,
          categoryId: effectiveCategoryId,
          description: plaidTx.merchantName || plaidTx.name,
          details: plaidTx.name,
          debit: isDebit ? absAmount : null,
          credit: isDebit ? null : absAmount,
          currency: plaidTx.isoCurrencyCode || 'USD',
          accountId: localAccountId,
          tenantId: user.tenantId,
          source: 'PLAID',
          externalId: plaidTx.plaidTransactionId,
        },
      });

      affectedAccountIds.add(localAccountId);
      affectedDateScopes.add(`${year}-${month}`);
    }

    // ── Phase 3a: Batch-mark hash duplicates ──────────────────────────────
    if (hashDuplicateIds.length > 0) {
      await prisma.plaidTransaction.updateMany({
        where: { id: { in: hashDuplicateIds } },
        data: { promotionStatus: 'DUPLICATE', processed: true },
      });
      skipped += hashDuplicateIds.length;
    }

    // ── Phase 3b: Update already-existing (link only, all in parallel) ─────
    if (alreadyExisting.length > 0) {
      const linkResults = await Promise.allSettled(
        alreadyExisting.map(({ plaidTx, existingTxId }) =>
          prisma.plaidTransaction.update({
            where: { id: plaidTx.id },
            data: {
              promotionStatus: 'PROMOTED',
              matchedTransactionId: existingTxId,
              ...(overrideCategoryId && {
                suggestedCategoryId: overrideCategoryId,
                classificationSource: 'USER_OVERRIDE',
                aiConfidence: 1.0,
              }),
            },
          })
        )
      );
      for (const r of linkResults) {
        if (r.status === 'fulfilled') promoted++;
        else { console.error(`Bulk promote link error: ${r.reason?.message}`); errors++; }
      }
    }

    // ── Phase 3c: Batch-create new Transactions via createMany ────────────
    if (toCreate.length > 0) {
      try {
        const { count } = await prisma.transaction.createMany({
          data: toCreate.map((item) => item.transactionData),
          skipDuplicates: true,
        });

        // Look up created transactions by externalId to get their IDs
        const createdExternalIds = toCreate.map((item) => item.plaidTx.plaidTransactionId);
        const createdTransactions = await prisma.transaction.findMany({
          where: {
            externalId: { in: createdExternalIds },
            tenantId: user.tenantId,
          },
          select: { id: true, externalId: true },
        });
        const externalIdToTxId = new Map(
          createdTransactions.map((t) => [t.externalId, t.id])
        );

        // Update PlaidTransactions with matchedTransactionId (all in parallel)
        const updateResults = await Promise.allSettled(
          toCreate.map(({ plaidTx }) => {
            const matchedId = externalIdToTxId.get(plaidTx.plaidTransactionId);
            return prisma.plaidTransaction.update({
              where: { id: plaidTx.id },
              data: {
                promotionStatus: 'PROMOTED',
                matchedTransactionId: matchedId || null,
                ...(overrideCategoryId && {
                  suggestedCategoryId: overrideCategoryId,
                  classificationSource: 'USER_OVERRIDE',
                  aiConfidence: 1.0,
                }),
              },
            });
          })
        );
        for (const r of updateResults) {
          if (r.status === 'fulfilled') promoted++;
          else { console.error(`Bulk promote update error: ${r.reason?.message}`); errors++; }
        }
      } catch (err) {
        // createMany or findMany failed — all toCreate items are errors
        console.error(`Bulk promote batch create error: ${err.message}`);
        Sentry.captureException(err);
        errors += toCreate.length;
      }
    }

    // ── Phase 3d: Fire-and-forget batch feedback for promoted transactions ─
    // Updates the DescriptionMapping table and embedding indexes so future
    // classifications benefit from these confirmed description→category pairs.
    if (toCreate.length > 0) {
      const feedbackEntries = toCreate
        .map(({ plaidTx }) => ({
          description: plaidTx.merchantName || plaidTx.name,
          categoryId: overrideCategoryId ?? plaidTx.suggestedCategoryId,
        }))
        .filter((e) => e.description && e.categoryId);

      if (feedbackEntries.length > 0) {
        fetchWithTimeout(`${BACKEND_URL}/api/feedback/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': BACKEND_API_KEY },
          body: JSON.stringify({ tenantId: user.tenantId, entries: feedbackEntries }),
        }, 25000).catch((err) => {
          // Feedback is non-critical — log but don't alert Sentry for timeouts
          console.warn(`Bulk promote batch feedback error: ${err.message}`);
          if (err.name !== 'AbortError') {
            Sentry.captureException(err, { extra: { eventType: 'feedback-batch', count: feedbackEntries.length } });
          }
        }); // Non-blocking
      }
    }

    // ── Phase 4: Trigger downstream processing (fire-and-forget) ──────────
    // produceEvent has internal retry + timeout + Sentry, so it's safe to
    // not await — the user gets their response immediately after DB work.
    if (promoted > 0) {
      produceEvent({
        type: 'TRANSACTIONS_IMPORTED',
        tenantId: user.tenantId,
        accountIds: Array.from(affectedAccountIds),
        dateScopes: Array.from(affectedDateScopes).map((ds) => {
          const [year, month] = ds.split('-');
          return { year: parseInt(year), month: parseInt(month) };
        }),
        source: 'PLAID_BULK_PROMOTE',
      }).catch(() => {}); // already logs + reports internally
    }

    res.status(StatusCodes.OK).json({ promoted, skipped, errors });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Bulk promote error:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
