import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { cors } from '../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { produceEvent } from '../../../../utils/produceEvent.js';
import { withAuth } from '../../../../utils/withAuth.js';
import { computeTransactionHash, buildDuplicateHashSet } from '../../../../utils/transactionHash.js';

// Max concurrent simple updates (non-transactional) — safe for connection pool
const UPDATE_CONCURRENCY = 10;

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

    // Validate overrideCategoryId belongs to this tenant
    if (overrideCategoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: overrideCategoryId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!cat) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid category' });
      }
    }

    // Get tenant's Plaid items
    const tenantPlaidItems = await prisma.plaidItem.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true },
    });
    const tenantPlaidItemIds = tenantPlaidItems.map((pi) => pi.id);

    if (tenantPlaidItemIds.length === 0) {
      return res.status(StatusCodes.OK).json({ promoted: 0, skipped: 0, errors: 0 });
    }

    // Build account map: plaidAccountId → local accountId
    const linkedAccounts = await prisma.account.findMany({
      where: { tenantId: user.tenantId, plaidAccountId: { not: null } },
      select: { id: true, plaidAccountId: true },
    });
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

    // ── Phase 1: Batch dedup lookups (2 queries total) ─────────────────────
    const allExternalIds = eligibleTransactions.map((t) => t.plaidTransactionId);
    const existingTransactions = await prisma.transaction.findMany({
      where: { externalId: { in: allExternalIds } },
      select: { id: true, externalId: true },
    });
    const existingByExternalId = new Map(existingTransactions.map((t) => [t.externalId, t.id]));

    const uniqueLocalAccountIds = new Set();
    for (const plaidTx of eligibleTransactions) {
      const localId = accountMap.get(plaidTx.plaidAccountId);
      if (localId) uniqueLocalAccountIds.add(localId);
    }
    const hashSetByAccountId = new Map();
    for (const accountId of uniqueLocalAccountIds) {
      hashSetByAccountId.set(accountId, await buildDuplicateHashSet(user.tenantId, accountId));
    }

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

    // ── Phase 3b: Update already-existing (link only, small concurrent batches) ──
    for (let i = 0; i < alreadyExisting.length; i += UPDATE_CONCURRENCY) {
      const batch = alreadyExisting.slice(i, i + UPDATE_CONCURRENCY);
      await Promise.all(batch.map(async ({ plaidTx, existingTxId }) => {
        try {
          await prisma.plaidTransaction.update({
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
          });
          promoted++;
        } catch (err) {
          console.error(`Bulk promote link error for ${plaidTx.id}: ${err.message}`);
          errors++;
        }
      }));
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

        // Update PlaidTransactions with matchedTransactionId (small concurrent batches)
        for (let i = 0; i < toCreate.length; i += UPDATE_CONCURRENCY) {
          const batch = toCreate.slice(i, i + UPDATE_CONCURRENCY);
          await Promise.all(batch.map(async ({ plaidTx }) => {
            try {
              const matchedId = externalIdToTxId.get(plaidTx.plaidTransactionId);
              await prisma.plaidTransaction.update({
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
              promoted++;
            } catch (err) {
              console.error(`Bulk promote update error for ${plaidTx.id}: ${err.message}`);
              errors++;
            }
          }));
        }
      } catch (err) {
        // createMany or findMany failed — all toCreate items are errors
        console.error(`Bulk promote batch create error: ${err.message}`);
        Sentry.captureException(err);
        errors += toCreate.length;
      }
    }

    // ── Phase 4: Trigger downstream processing ───────────────────────────
    if (promoted > 0) {
      try {
        await produceEvent({
          type: 'TRANSACTIONS_IMPORTED',
          tenantId: user.tenantId,
          accountIds: Array.from(affectedAccountIds),
          dateScopes: Array.from(affectedDateScopes).map((ds) => {
            const [year, month] = ds.split('-');
            return { year: parseInt(year), month: parseInt(month) };
          }),
          source: 'PLAID_BULK_PROMOTE',
        });
      } catch (eventErr) {
        // Non-fatal — transactions are committed, event can be retried
        console.error('Failed to produce TRANSACTIONS_IMPORTED event after bulk promote:', eventErr.message);
        Sentry.captureException(eventErr);
      }
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
