import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { cors } from '../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { produceEvent } from '../../../../utils/produceEvent.js';
import { withAuth } from '../../../../utils/withAuth.js';
import { computeTransactionHash, buildDuplicateHashSet } from '../../../../utils/transactionHash.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

/**
 * PUT /api/plaid/transactions/:id
 *
 * Update a PlaidTransaction:
 *   - Change suggestedCategoryId (override AI classification)
 *   - Set promotionStatus to PROMOTED (creates a Transaction record)
 *   - Set promotionStatus to SKIPPED
 *
 * Body: { suggestedCategoryId?: number, promotionStatus?: 'PROMOTED' | 'SKIPPED' }
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

  if (req.method !== 'PUT') {
    res.setHeader('Allow', ['PUT']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const user = req.user;

    const { id } = req.query;
    if (!id) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing transaction ID' });
    }

    // Fetch the PlaidTransaction and verify tenant ownership
    const plaidTx = await prisma.plaidTransaction.findUnique({
      where: { id },
      include: {
        plaidItem: { select: { tenantId: true } },
      },
    });

    if (!plaidTx) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'PlaidTransaction not found' });
    }

    if (plaidTx.plaidItem.tenantId !== user.tenantId) {
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Access denied' });
    }

    // Cannot modify already-promoted transactions
    if (plaidTx.promotionStatus === 'PROMOTED') {
      return res.status(StatusCodes.CONFLICT).json({ error: 'Transaction already promoted' });
    }

    const { suggestedCategoryId, promotionStatus, ticker, assetQuantity, assetPrice, details, isin, exchange, assetCurrency } = req.body;

    // ─── Re-queue: SKIPPED → CLASSIFIED ────────────────────────────
    if (promotionStatus === 'CLASSIFIED' && plaidTx.promotionStatus === 'SKIPPED') {
      const updated = await prisma.plaidTransaction.update({
        where: { id },
        data: { promotionStatus: 'CLASSIFIED' },
      });
      return res.status(StatusCodes.OK).json(updated);
    }

    // ─── Category override only (no status change) ───────────────────
    if (suggestedCategoryId && !promotionStatus) {
      // Validate category belongs to tenant
      const category = await prisma.category.findFirst({
        where: { id: suggestedCategoryId, tenantId: user.tenantId },
      });
      if (!category) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid category' });
      }

      // Detect whether the new category requires investment enrichment
      const MANDATORY_HINTS = ['API_STOCK', 'API_CRYPTO', 'API_FUND'];
      const isMandatoryInvestment =
        category.type === 'Investments' && MANDATORY_HINTS.includes(category.processingHint);

      const enrichmentUpdate = isMandatoryInvestment
        ? { requiresEnrichment: true, enrichmentType: 'INVESTMENT' }
        : { requiresEnrichment: false, enrichmentType: null };

      const updated = await prisma.plaidTransaction.update({
        where: { id },
        data: {
          suggestedCategoryId,
          classificationSource: 'USER_OVERRIDE',
          aiConfidence: 1.0,
          ...enrichmentUpdate,
        },
      });

      // Fire-and-forget feedback to improve future classifications
      const descriptionForFeedback = plaidTx.merchantName || plaidTx.name;
      fetch(`${BACKEND_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': BACKEND_API_KEY },
        body: JSON.stringify({
          description: descriptionForFeedback,
          categoryId: suggestedCategoryId,
          tenantId: user.tenantId,
        }),
      }).catch(() => {}); // Non-fatal

      return res.status(StatusCodes.OK).json(updated);
    }

    // ─── Skip ────────────────────────────────────────────────────────
    if (promotionStatus === 'SKIPPED') {
      const updated = await prisma.plaidTransaction.update({
        where: { id },
        data: { promotionStatus: 'SKIPPED' },
      });
      return res.status(StatusCodes.OK).json(updated);
    }

    // ─── Promote (create Transaction) ────────────────────────────────
    if (promotionStatus === 'PROMOTED') {
      // If a category override is provided alongside promotion, apply it
      const finalCategoryId = suggestedCategoryId || plaidTx.suggestedCategoryId;

      if (!finalCategoryId) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Cannot promote without a category. Please assign a category first.',
        });
      }

      // Validate category
      const category = await prisma.category.findFirst({
        where: { id: finalCategoryId, tenantId: user.tenantId },
      });
      if (!category) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid category' });
      }

      // Investment enrichment validation (Sprint 12)
      // If the category has an investment processingHint, require ticker/quantity/price
      const INVESTMENT_HINTS = ['API_STOCK', 'API_CRYPTO', 'API_FUND', 'MANUAL'];
      const isInvestmentCategory = category.type === 'Investments' &&
        INVESTMENT_HINTS.includes(category.processingHint);
      // Validate ticker contains at least one letter — pure numeric "0" is not a valid ticker
      const hasValidTicker = ticker && /[a-zA-Z]/.test(ticker);
      if (isInvestmentCategory && (!hasValidTicker || assetQuantity == null || assetPrice == null)) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Investment transactions require a valid ticker (with letters), assetQuantity, and assetPrice.',
          requiresEnrichment: true,
        });
      }

      // Find the linked local account for this Plaid account
      const localAccount = await prisma.account.findFirst({
        where: { plaidAccountId: plaidTx.plaidAccountId, tenantId: user.tenantId },
      });
      if (!localAccount) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'No linked account found for this Plaid account. Please link accounts first.',
        });
      }

      // Check for existing transaction with same externalId (dedup)
      const existingTx = await prisma.transaction.findUnique({
        where: { externalId: plaidTx.plaidTransactionId },
      });
      if (existingTx) {
        // Already promoted — just update the PlaidTransaction record
        const updated = await prisma.plaidTransaction.update({
          where: { id },
          data: {
            promotionStatus: 'PROMOTED',
            matchedTransactionId: existingTx.id,
            ...(suggestedCategoryId && {
              suggestedCategoryId,
              classificationSource: 'USER_OVERRIDE',
              aiConfidence: 1.0,
            }),
          },
        });
        return res.status(StatusCodes.OK).json(updated);
      }

      // Hash-based dedup: catch duplicates from manual entry or CSV import
      const plaidAmount = Number(plaidTx.amount);
      const absAmount = Math.abs(plaidAmount);
      const txDate = new Date(plaidTx.date);
      const candidateHash = computeTransactionHash(
        txDate,
        plaidTx.merchantName || plaidTx.name,
        absAmount,
        localAccount.id,
      );
      const hashSet = await buildDuplicateHashSet(user.tenantId, localAccount.id, txDate, txDate);
      if (hashSet.has(candidateHash)) {
        // Mark as DUPLICATE so it doesn't keep appearing for review
        await prisma.plaidTransaction.update({
          where: { id },
          data: { promotionStatus: 'DUPLICATE', processed: true },
        });
        return res.status(StatusCodes.CONFLICT).json({
          error: 'A matching transaction already exists (duplicate detected by content hash).',
          duplicate: true,
        });
      }

      // Determine debit/credit from Plaid amount (plaidAmount, absAmount, txDate already computed above)
      const isDebit = plaidAmount > 0;

      // Build the transaction date parts
      const year = txDate.getFullYear();
      const month = txDate.getMonth() + 1;
      const day = txDate.getDate();
      const quarter = `Q${Math.ceil(month / 3)}`;

      // Use a Prisma transaction to atomically create + update
      const result = await prisma.$transaction(async (tx) => {
        const newTransaction = await tx.transaction.create({
          data: {
            transaction_date: txDate,
            year,
            quarter,
            month,
            day,
            categoryId: finalCategoryId,
            description: plaidTx.merchantName || plaidTx.name,
            details: details || plaidTx.name,
            debit: isDebit ? absAmount : null,
            credit: isDebit ? null : absAmount,
            currency: plaidTx.isoCurrencyCode || 'USD',
            accountId: localAccount.id,
            tenantId: user.tenantId,
            source: 'PLAID',
            externalId: plaidTx.plaidTransactionId,
            // Investment fields (Sprint 12) — optional, only set when enriched
            // Validate ticker contains at least one letter — reject pure numeric placeholders like "0"
            ...(ticker && /[a-zA-Z]/.test(ticker) && { ticker }),
            ...(assetQuantity != null && { assetQuantity: parseFloat(assetQuantity) }),
            ...(assetPrice != null && { assetPrice: parseFloat(assetPrice) }),
            // Ticker resolution metadata (Sprint 14)
            ...(isin && { isin }),
            ...(exchange && { exchange }),
            ...(assetCurrency && { assetCurrency }),
          },
        });

        const updatedPlaidTx = await tx.plaidTransaction.update({
          where: { id },
          data: {
            promotionStatus: 'PROMOTED',
            matchedTransactionId: newTransaction.id,
            ...(suggestedCategoryId && {
              suggestedCategoryId,
              classificationSource: 'USER_OVERRIDE',
              aiConfidence: 1.0,
            }),
          },
        });

        return updatedPlaidTx;
      });

      // Trigger downstream processing (portfolio, analytics) — scoped to this transaction
      try {
        await produceEvent({
          type: 'TRANSACTIONS_IMPORTED',
          tenantId: user.tenantId,
          accountIds: [localAccount.id],
          dateScope: { year, month },
          source: 'PLAID_PROMOTE',
        });
      } catch (eventErr) {
        // Non-fatal — transaction is committed, event can be retried
        console.error('Failed to produce TRANSACTIONS_IMPORTED event:', eventErr.message);
        Sentry.captureException(eventErr);
      }

      // Fire-and-forget feedback with transactionId so the embedding is linked
      const descForFeedback = plaidTx.merchantName || plaidTx.name;
      fetch(`${BACKEND_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': BACKEND_API_KEY },
        body: JSON.stringify({
          description: descForFeedback,
          categoryId: finalCategoryId,
          tenantId: user.tenantId,
          transactionId: result.matchedTransactionId,
        }),
      }).catch(() => {}); // Non-fatal

      return res.status(StatusCodes.OK).json(result);
    }

    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Invalid request. Provide suggestedCategoryId and/or promotionStatus (PROMOTED|SKIPPED).',
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Plaid transaction update error:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
