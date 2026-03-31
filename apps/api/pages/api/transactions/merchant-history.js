/**
 * GET /api/transactions/merchant-history?description=<text>&limit=<n>
 *
 * Returns recent promoted transactions matching a merchant name.
 * Used by the Transaction Review inbox to show "History with this merchant".
 *
 * NOTE: Transaction.description is encrypted (searchable: false), so text search
 * on the Transaction table returns nothing. Instead, we search PlaidTransaction
 * by merchantName (unencrypted) where promotionStatus = 'PROMOTED', then look up
 * the associated category.
 */

import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors';
import { rateLimiters } from '../../../utils/rateLimit';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma';
import { withAuth } from '../../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    const limiter = rateLimiters.accounts || rateLimiters.common;
    if (limiter) {
      limiter(req, res, (result) => {
        if (result instanceof Error) return reject(result);
        resolve(result);
      });
    } else {
      resolve();
    }
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const { description, limit } = req.query;
  if (!description) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing description query parameter' });
  }

  try {
    const user = req.user;
    const take = Math.min(parseInt(limit) || 10, 50);
    const normalised = description.trim().toLowerCase();

    // Get tenant's Plaid items for scoping
    const tenantPlaidItems = await prisma.plaidItem.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true },
    });
    const plaidItemIds = tenantPlaidItems.map((pi) => pi.id);

    if (plaidItemIds.length === 0) {
      return res.status(StatusCodes.OK).json([]);
    }

    // Search PlaidTransaction by merchantName/name (unencrypted fields)
    // Only return promoted transactions (already committed to ledger)
    const plaidHistory = await prisma.plaidTransaction.findMany({
      where: {
        plaidItemId: { in: plaidItemIds },
        promotionStatus: 'PROMOTED',
        OR: [
          { merchantName: { contains: normalised, mode: 'insensitive' } },
          { name: { contains: normalised, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        date: true,
        merchantName: true,
        name: true,
        amount: true,
        isoCurrencyCode: true,
        suggestedCategoryId: true,
        matchedTransactionId: true,
      },
      orderBy: { date: 'desc' },
      take,
    });

    // Batch-fetch categories for the results
    const categoryIds = [
      ...new Set(plaidHistory.map((pt) => pt.suggestedCategoryId).filter(Boolean)),
    ];
    const categoriesMap = new Map();
    if (categoryIds.length > 0) {
      const cats = await prisma.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true, group: true },
      });
      for (const cat of cats) {
        categoriesMap.set(cat.id, cat);
      }
    }

    // Map to the response shape expected by the frontend (MerchantHistoryTransaction)
    const results = plaidHistory.map((pt) => {
      const plaidAmount = Number(pt.amount);
      return {
        id: pt.matchedTransactionId ?? pt.id,
        transaction_date: pt.date,
        description: pt.merchantName || pt.name,
        debit: plaidAmount > 0 ? Math.abs(plaidAmount) : null,
        credit: plaidAmount < 0 ? Math.abs(plaidAmount) : null,
        currency: pt.isoCurrencyCode || 'USD',
        source: 'PLAID',
        category: pt.suggestedCategoryId
          ? categoriesMap.get(pt.suggestedCategoryId) ?? null
          : null,
        account: null,
      };
    });

    return res.status(StatusCodes.OK).json(results);
  } catch (error) {
    Sentry.captureException(error);
    console.error('Merchant history error:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to fetch merchant history',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
