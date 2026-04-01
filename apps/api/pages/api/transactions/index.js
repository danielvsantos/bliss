import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { Decimal } from '@prisma/client/runtime/library';
import { handleDebtRepayment } from '../../../services/transaction.service.js';
import { produceEvent } from '../../../utils/produceEvent.js';
import { withAuth } from '../../../utils/withAuth.js';
import { resolveTagsByName } from '../../../utils/tagUtils.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.transactions(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  // Handle CORS
  if (cors(req, res)) return;
  try {
    switch (req.method) {
      case 'GET':
        await handleGet(req, res);
        break;
      case 'POST':
        await handlePost(req, res);
        break;
      case 'PUT':
        await handlePut(req, res);
        break;
      case 'DELETE':
        await handleDelete(req, res);
        break;
      default:
        res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
        res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
        break;
    }
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

async function handleGet(req, res) {
  const tenantId = req.user.tenantId;
  const {
    id,
    year,
    month,
    quarter,
    categoryId,
    accountId,
    currencyCode,
    accountCountry,
    tags,
    'tags[]': tagsArray,
    group,
    type,
    page = 1,
    limit = 100,
    sortBy = 'transaction_date',
    sortOrder = 'desc',
    source, // [NEW] Filter by source (MANUAL, PLAID, CSV)
    startDate,
    endDate,
  } = req.query;

  // Normalize tags input to always be an array
  const normalizedTags = tagsArray || (Array.isArray(tags) ? tags : tags ? [tags] : null);

  if (id) {
    const transactionId = parseInt(id, 10);
    if (isNaN(transactionId)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid transaction ID' });
      return;
    }

    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        account: {
          select: {
            name: true,
            currencyCode: true,
            country: true
          }
        },
        category: { select: { name: true, group: true, type: true, icon: true } },
        tags: {
          include: {
            tag: {
              select: {
                id: true,
                name: true,
                color: true,
                emoji: true
              }
            }
          }
        }
      },
    });

    if (!transaction || transaction.tenantId !== tenantId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Transaction not found in this tenant' });
      return;
    }

    const transformedTransaction = {
      ...transaction,
      tags: transaction.tags.map(t => t.tag)
    };

    res.status(StatusCodes.OK).json(transformedTransaction);
    return;
  }

  // Build filter conditions
  const filters = {
    tenantId,
    ...(year && { year: parseInt(year, 10) }),
    ...(month && { month: parseInt(month, 10) }),
    ...(quarter && { quarter }),
    ...(categoryId && { categoryId: parseInt(categoryId, 10) }),
    ...(accountId && { accountId: parseInt(accountId, 10) }),
    ...(currencyCode && { currency: currencyCode.toUpperCase() }),
    ...(accountCountry && {
      account: {
        countryId: accountCountry.toUpperCase()
      }
    }),
    ...(normalizedTags && {
      tags: {
        some: {
          tag: {
            OR: normalizedTags.map(tag => ({
              OR: [
                { id: !isNaN(parseInt(tag, 10)) ? parseInt(tag, 10) : undefined },
                { name: typeof tag === 'string' ? tag : undefined }
              ]
            }))
          }
        }
      }
    }),
    ...(group && { category: { group } }),
    ...(type && { category: { type } }),
    ...(source && { source }), // [NEW] Apply source filter
    ...(startDate || endDate ? {
      transaction_date: {
        ...(startDate && { gte: new Date(startDate) }),
        ...(endDate && { lte: new Date(endDate + 'T23:59:59.999Z') }),
      },
    } : {}),
  };

  // Parse pagination parameters
  const numericPage = Math.max(parseInt(page, 10), 1);
  const numericLimit = Math.min(parseInt(limit, 10), 1000);
  const skip = (numericPage - 1) * numericLimit;

  // Validate sort parameters
  const allowedSortFields = ['transaction_date', 'credit', 'debit', 'currency'];
  const actualSortField = allowedSortFields.includes(sortBy) ? sortBy : 'transaction_date';
  const actualSortOrder = sortOrder === 'asc' ? 'asc' : 'desc';

  // Custom sorting for credit and debit fields
  let orderBy;
  if (actualSortField === 'credit') {
    // For credit: nulls last, then sort by value
    orderBy = {
      credit: {
        sort: actualSortOrder,
        nulls: 'last'
      }
    };
  } else if (actualSortField === 'debit') {
    // For debit: nulls last, then sort by value
    orderBy = {
      debit: {
        sort: actualSortOrder,
        nulls: 'last'
      }
    };
  } else {
    orderBy = { [actualSortField]: actualSortOrder };
  }

  try {
    // Get filtered transactions with pagination and calculate totals
    const [transactions, total, totals] = await Promise.all([
      prisma.transaction.findMany({
        where: filters,
        include: {
          account: {
            select: {
              name: true,
              currencyCode: true,
              country: true
            }
          },
          category: { select: { name: true, group: true, type: true, icon: true } },
          tags: {
            include: {
              tag: {
                select: {
                  id: true,
                  name: true,
                  color: true,
                  emoji: true
                }
              }
            }
          }
        },
        orderBy,
        skip,
        take: numericLimit,
      }),
      prisma.transaction.count({ where: filters }),
      prisma.transaction.aggregate({
        where: filters,
        _sum: {
          credit: true,
          debit: true
        }
      })
    ]);

    const totalCredit = new Decimal(totals._sum.credit || 0);
    const totalDebit = new Decimal(totals._sum.debit || 0);

    const transformedTransactions = transactions.map(t => ({
      ...t,
      tags: t.tags.map(tt => tt.tag)
    }));

    res.status(StatusCodes.OK).json({
      transactions: transformedTransactions,
      total,
      page: numericPage,
      limit: numericLimit,
      totalPages: Math.ceil(total / numericLimit),
      totals: {
        credit: totalCredit,
        debit: totalDebit,
        balance: totalCredit.minus(totalDebit)
      },
      filters: {
        year,
        month,
        quarter,
        categoryId,
        accountId,
        currencyCode,
        accountCountry,
        tags: normalizedTags,
        group,
        type
      },
      sort: {
        field: actualSortField,
        order: actualSortOrder
      }
    });
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to fetch transactions',
      details: error.message
    });
  }
}

async function handlePost(req, res) {
  const { tenantId, email: userId } = req.user;
  const { transaction_date, tags, categoryGroup, debtTerms, ...transactionData } = req.body;

  try {
    // Normalise to midnight UTC so hash-based dedup matches Plaid dates.
    // Date-only strings ("2026-01-11") are parsed as UTC by the JS spec;
    // full ISO timestamps are handled via the length-10 guard for safety.
    const date = new Date(
      typeof transaction_date === 'string' && transaction_date.length === 10
        ? transaction_date + 'T00:00:00.000Z'
        : transaction_date
    );
    if (isNaN(date.getTime())) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid transaction_date format.' });
    }
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const quarter = `Q${Math.ceil(month / 3)}`;

    let tagConnections;
    let resolvedTagIds = [];
    if (tags && Array.isArray(tags)) {
      const resolvedTags = await resolveTagsByName(tags, tenantId, userId);
      resolvedTagIds = resolvedTags.map(t => t.id);
      if (resolvedTags.length > 0) {
        tagConnections = {
          create: resolvedTags.map(tag => ({ tag: { connect: { id: tag.id } } }))
        };
      }
    }

    // 1. Find or create the PortfolioItem
    let portfolioItem;
    const [category, account] = await Promise.all([
      prisma.category.findUnique({ where: { id: transactionData.categoryId } }),
      prisma.account.findUnique({ where: { id: transactionData.accountId } })
    ]);

    if (category && (category.type === 'Investments' || category.type === 'Debt')) {
      const { ticker, description, currency } = transactionData;

      // Generate symbol using the same logic as the backend's portfolioKeyGenerator
      let symbol;
      switch (category.portfolioItemKeyStrategy) {
        case 'TICKER':
          // Validate ticker contains at least one letter — reject pure numeric like "0"
          symbol = ticker && /[a-zA-Z]/.test(ticker) ? ticker : null;
          break;
        case 'CATEGORY_NAME':
          symbol = category.name.replace(/\s/g, '_');
          break;
        case 'CATEGORY_NAME_PLUS_DESCRIPTION':
          const safeDescription = description.replace(/[^a-zA-Z0-9]/g, '_');
          symbol = `${category.name}_${safeDescription}`;
          break;
        case 'IGNORE':
        default:
          symbol = null;
          break;
      }

      if (!symbol) {
        // If no symbol could be generated (and it's required), this transaction doesn't belong to a portfolio item.
        // We can proceed to create the transaction without linking it.
      } else {
        portfolioItem = await prisma.portfolioItem.upsert({
          where: { tenantId_symbol: { tenantId, symbol } },
          update: {}, // No fields to update on existing item here
          create: {
            tenantId,
            categoryId: category.id,
            symbol,
            currency,
            source: ticker ? 'SYNCED' : 'MANUAL',
          },
        });

        if (portfolioItem && debtTerms) {
          await prisma.debtTerms.create({
            data: {
              assetId: portfolioItem.id,
              interestRate: debtTerms.interestRate,
              termInMonths: debtTerms.termInMonths,
              originationDate: debtTerms.originationDate || date,
              initialBalance: debtTerms.initialBalance,
            }
          });
        }
      }
    }

    // Prepare final data for creation
    const dataToCreate = {
      ...transactionData,
      transaction_date: date,
      year,
      month,
      day,
      quarter,
      tenantId,
      userId,
      portfolioItemId: portfolioItem?.id,
      ...(tagConnections && { tags: tagConnections })
    };

    // Scenario: Check for Debt Repayment (triggers split)
    if (transactionData.debit > 0 && category && category.type === 'Debt') {
      const splitTransactionsData = await handleDebtRepayment(prisma, tenantId, userId, dataToCreate);
      if (splitTransactionsData) {
        const createdTransactions = await prisma.$transaction(
          splitTransactionsData.map(txData => {
            const isPrincipalPayment = txData.categoryId === transactionData.categoryId;
            const finalPortfolioItemId = isPrincipalPayment ? portfolioItem?.id : null;
            return prisma.transaction.create({
              data: { ...txData, portfolioItemId: finalPortfolioItemId },
            });
          })
        );
        // After the transactions are created, find the principal one to trigger the event.
        const principalTx = createdTransactions.find(tx => tx.portfolioItemId);
        if (principalTx) {
          // The interest expense transaction also needs an event for analytics.
          const interestTx = createdTransactions.find(tx => !tx.portfolioItemId);

          // Enrich and send event for the principal portion
          await produceEvent({
            type: 'MANUAL_TRANSACTION_CREATED',
            tenantId,
            transactionId: principalTx.id,
            transaction_date: principalTx.transaction_date,
            portfolioItemId: principalTx.portfolioItemId,
            currency: principalTx.currency,
            country: account?.countryId,
            categoryType: category?.type,
            categoryGroup: category?.group,
          });

          // Enrich and send event for the interest portion
          if (interestTx) {
            const interestCategory = await prisma.category.findUnique({ where: { id: interestTx.categoryId } });
            await produceEvent({
              type: 'MANUAL_TRANSACTION_CREATED',
              tenantId,
              transactionId: interestTx.id,
              transaction_date: interestTx.transaction_date,
              portfolioItemId: null,
              currency: interestTx.currency,
              country: account?.countryId,
              categoryType: interestCategory?.type,
              categoryGroup: interestCategory?.group,
            });
          }
        } else {
          console.log(`[Debt Split] CRITICAL: Could not find principal transaction after split. No event produced.`);
        }

        return res.status(StatusCodes.OK).json(createdTransactions);
      }
    }

    // Fallback: Standard Transaction
    const newTransaction = await prisma.transaction.create({
      data: dataToCreate,
    });

    const { id: transactionId, portfolioItemId, transaction_date: txDate } = newTransaction;

    // Enrich the event payload with data we already have in memory
    await produceEvent({
      type: 'MANUAL_TRANSACTION_CREATED',
      tenantId: req.user.tenantId,
      transactionId: transactionId,
      transaction_date: txDate,
      portfolioItemId: portfolioItemId,
      currency: newTransaction.currency,
      country: account?.countryId,
      categoryType: category?.type,
      categoryGroup: category?.group,
    });

    // Fire-and-forget feedback for the description→category mapping.
    // Teaches the classification system from manually created transactions.
    if (transactionData.description && transactionData.categoryId) {
      fetch(`${BACKEND_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': BACKEND_API_KEY },
        body: JSON.stringify({
          description: transactionData.description,
          categoryId: parseInt(transactionData.categoryId, 10),
          tenantId,
        }),
      }).catch(() => {}); // Non-fatal
    }

    // Emit TAG_ASSIGNMENT_MODIFIED if tags were set on creation
    if (resolvedTagIds.length > 0) {
      await produceEvent({
        type: 'TAG_ASSIGNMENT_MODIFIED',
        tenantId,
        tagIds: resolvedTagIds,
        transactionScopes: [{
          year,
          month,
          currency: newTransaction.currency,
          country: account?.countryId,
        }],
      });
    }

    res.status(StatusCodes.CREATED).json(newTransaction);
  } catch (error) {
    Sentry.captureException(error);
    console.error("Failed to create transaction:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: "Failed to create transaction",
      details: error.message
    });
  }
}

// This function is no longer needed in this file, as origination is just a standard transaction.
// async function handleDebtOrigination(...) { ... }

// The handleDebtRepayment function has been moved to services/transaction.service.js

async function handlePut(req, res) {
  const tenantId = req.user.tenantId;
  const { id } = req.query;
  const transactionId = parseInt(id, 10);

  if (isNaN(transactionId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid transaction ID' });
    return;
  }

  try {
    const existing = await prisma.transaction.findUnique({
      where: { id: transactionId },
      // Eagerly fetch relations needed for event payload + tag change detection
      include: { account: true, category: true, tags: { select: { tagId: true } } }
    });
    if (!existing || existing.tenantId !== tenantId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Transaction not found in this tenant' });
      return;
    }

    const {
      transaction_date, categoryId, accountId,
      description, details, credit, debit, currency,
      assetQuantity, assetPrice, ticker, tags,
      categoryGroup, debtTerms, isin, exchange, assetCurrency
    } = req.body;

    if (!transaction_date || !categoryId || !accountId || !description || !currency || (!credit && !debit)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing required fields for transaction update.' });
      return;
    }
    if (credit && debit) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Transaction cannot have both credit and debit amounts.' });
      return;
    }

    // Normalise to midnight UTC (same logic as handlePost)
    const date = new Date(
      typeof transaction_date === 'string' && transaction_date.length === 10
        ? transaction_date + 'T00:00:00.000Z'
        : transaction_date
    );
    if (isNaN(date.getTime())) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid transaction_date format.' });
      return;
    }
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const quarter = `Q${Math.ceil(month / 3)}`;

    // 2. Find or create the PortfolioItem for the updated transaction
    let portfolioItem;
    // We fetch the new category to determine if a portfolio item link is needed.
    const newCategory = await prisma.category.findUnique({ where: { id: parseInt(categoryId, 10) } });
    if (newCategory && (newCategory.type === 'Investments' || newCategory.type === 'Debt')) {
      // Generate symbol using the same logic as the backend's portfolioKeyGenerator
      let symbol;
      switch (newCategory.portfolioItemKeyStrategy) {
        case 'TICKER':
          // Validate ticker contains at least one letter — reject pure numeric like "0"
          symbol = ticker && /[a-zA-Z]/.test(ticker) ? ticker : null;
          break;
        case 'CATEGORY_NAME':
          symbol = newCategory.name.replace(/\s/g, '_');
          break;
        case 'CATEGORY_NAME_PLUS_DESCRIPTION':
          const safeDescription = description.replace(/[^a-zA-Z0-9]/g, '_');
          symbol = `${newCategory.name}_${safeDescription}`;
          break;
        case 'IGNORE':
        default:
          symbol = null;
          break;
      }

      if (!symbol) {
        // If no symbol could be generated, the updated transaction will not be linked to a portfolio item.
      } else {
        portfolioItem = await prisma.portfolioItem.upsert({
          where: { tenantId_symbol: { tenantId, symbol } },
          update: {},
          create: {
            tenantId,
            categoryId: newCategory.id,
            symbol,
            currency,
            source: ticker ? 'SYNCED' : 'MANUAL',
          },
        });

        if (portfolioItem && debtTerms) {
          await prisma.debtTerms.upsert({
            where: { assetId: portfolioItem.id },
            update: {
              interestRate: debtTerms.interestRate,
              termInMonths: debtTerms.termInMonths,
              originationDate: debtTerms.originationDate || date,
              initialBalance: debtTerms.initialBalance,
            },
            create: {
              assetId: portfolioItem.id,
              interestRate: debtTerms.interestRate,
              termInMonths: debtTerms.termInMonths,
              originationDate: debtTerms.originationDate || date,
              initialBalance: debtTerms.initialBalance,
            }
          });
        }
      }
    }

    let tagConnections = undefined;
    if (tags && Array.isArray(tags)) {
      const processedTags = await Promise.all(tags.map(async (tag) => {
        if (!isNaN(parseInt(tag, 10))) {
          const tagId = parseInt(tag, 10);
          const existingTag = await prisma.tag.findFirst({ where: { id: tagId, tenantId } });
          return existingTag ? { id: tagId } : null;
        } else if (typeof tag === 'string') {
          const name = tag.trim();
          if (!name) return null;
          let existingTag = await prisma.tag.findFirst({ where: { name, tenantId } });
          if (!existingTag) {
            existingTag = await prisma.tag.create({
              data: { name, tenantId, color: '#' + Math.floor(Math.random() * 16777215).toString(16) }
            });
            await prisma.auditLog.create({ data: { userId: req.user.email, action: "CREATE", table: "Tag", recordId: existingTag.id.toString(), tenantId } });
          }
          return { id: existingTag.id };
        }
        return null;
      }));
      const validTags = processedTags.filter(tag => tag !== null);
      tagConnections = {
        deleteMany: {},
        create: validTags.map(tag => ({ tag: { connect: { id: tag.id } } }))
      };
    }

    const result = await prisma.$transaction(async (prisma) => {
      const updatedTransaction = await prisma.transaction.update({
        where: { id: transactionId },
        data: {
          userId: req.user.email,
          transaction_date: date,
          year,
          quarter,
          month,
          day,
          categoryId: parseInt(categoryId, 10),
          accountId: parseInt(accountId, 10),
          description,
          details,
          credit: credit ? parseFloat(credit) : null,
          debit: debit ? parseFloat(debit) : null,
          currency,
          assetQuantity: assetQuantity ? parseFloat(assetQuantity) : null,
          assetPrice: assetPrice ? parseFloat(assetPrice) : null,
          ticker,
          isin: isin || null,
          exchange: exchange || null,
          assetCurrency: assetCurrency || null,
          portfolioItemId: portfolioItem?.id, // Link to the new/existing item
          ...(tagConnections !== undefined && { tags: tagConnections })
        },
        include: {
          account: {
            select: {
              name: true,
              currencyCode: true,
              country: true
            }
          },
          category: { select: { name: true, group: true, type: true } },
          tags: {
            include: {
              tag: {
                select: {
                  id: true,
                  name: true,
                  color: true,
                  emoji: true
                }
              }
            }
          }
        }
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.email,
          action: "UPDATE",
          table: "Transaction",
          recordId: updatedTransaction.id.toString(),
          tenantId,
        },
      });

      return updatedTransaction;
    });

    // Fire-and-forget feedback when category was changed — improves future classifications
    if (parseInt(categoryId, 10) !== existing.categoryId) {
      fetch(`${BACKEND_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': BACKEND_API_KEY },
        body: JSON.stringify({
          description,
          categoryId: parseInt(categoryId, 10),
          tenantId,
        }),
      }).catch(() => {}); // Non-fatal
    }

    // After the transaction is committed, trigger events for any affected scopes.
    // When the category or portfolioItem changed, we must also emit an event for the
    // OLD category/group so its analytics cache is recalculated (clearing stale entries).
    const categoryChanged = existing.categoryId !== result.categoryId;
    const portfolioItemChanged = existing.portfolioItemId && existing.portfolioItemId !== result.portfolioItemId;

    if (portfolioItemChanged || categoryChanged) {
      await produceEvent({
        type: 'MANUAL_TRANSACTION_MODIFIED',
        tenantId,
        transactionId: existing.id,
        transaction_date: existing.transaction_date,
        portfolioItemId: existing.portfolioItemId,
        currency: existing.currency,
        country: existing.account?.countryId,
        categoryType: existing.category?.type,
        categoryGroup: existing.category?.group,
      });
    }

    // Trigger event for the new state of the transaction.
    // The `result` object from the update includes the relations.
    await produceEvent({
      type: 'MANUAL_TRANSACTION_MODIFIED',
      tenantId,
      transactionId: result.id,
      transaction_date: result.transaction_date,
      portfolioItemId: result.portfolioItemId,
      currency: result.currency,
      country: result.account?.countryId,
      categoryType: result.category?.type,
      categoryGroup: result.category?.group,
    });

    // Emit TAG_ASSIGNMENT_MODIFIED if tags changed, so the tag analytics cache is recalculated
    if (tagConnections !== undefined) {
      const oldTagIds = (existing.tags || []).map(t => t.tagId);
      const newTagIds = result.tags.map(t => t.tag.id);
      const allAffectedTagIds = [...new Set([...oldTagIds, ...newTagIds])];

      if (allAffectedTagIds.length > 0) {
        await produceEvent({
          type: 'TAG_ASSIGNMENT_MODIFIED',
          tenantId,
          tagIds: allAffectedTagIds,
          transactionScopes: [{
            year: result.year,
            month: result.month,
            currency: result.currency,
            country: result.account?.countryId,
          }],
        });
      }
    }

    const transformedResult = {
      ...result,
      tags: result.tags.map(t => t.tag)
    };

    res.status(StatusCodes.OK).json(transformedResult);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Failed to update transaction',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}

async function handleDelete(req, res) {
  const tenantId = req.user.tenantId;
  const { id } = req.query;
  const transactionId = parseInt(id, 10);

  if (isNaN(transactionId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid transaction ID' });
    return;
  }

  try {
    const existing = await prisma.transaction.findUnique({
      where: { id: transactionId },
      // Fetch relations needed for event payload
      include: { category: true, account: true }
    });

    if (!existing || existing.tenantId !== tenantId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Transaction not found in this tenant' });
      return;
    }

    // Delete transaction, clean up related records, and create audit log atomically
    await prisma.$transaction(async (prisma) => {
      // Delete all TransactionTag entries for this transaction
      await prisma.transactionTag.deleteMany({
        where: { transactionId }
      });

      // Null out TransactionEmbedding FK — keep the embedding itself for future
      // vector similarity matching (keyed by tenantId+description, not transactionId)
      await prisma.transactionEmbedding.updateMany({
        where: { transactionId },
        data: { transactionId: null }
      });

      // Unlink any PlaidTransaction that was promoted to this transaction —
      // revert to CLASSIFIED so it reappears in the review queue for re-promotion
      await prisma.plaidTransaction.updateMany({
        where: { matchedTransactionId: transactionId },
        data: {
          matchedTransactionId: null,
          promotionStatus: 'CLASSIFIED',
        }
      });

      // Delete the transaction itself
      await prisma.transaction.delete({
        where: { id: transactionId }
      });

      // Create the audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.email,
          action: "DELETE",
          table: "Transaction",
          recordId: transactionId.toString(),
          tenantId,
        },
      });
    });

    // After deletion, check if we need to trigger a portfolio rebuild
    if (existing) { // `existing` includes category and account
      await produceEvent({
        type: 'MANUAL_TRANSACTION_MODIFIED', // Use the same event type for simplicity
        tenantId,
        transactionId: existing.id,
        transaction_date: existing.transaction_date,
        portfolioItemId: existing.portfolioItemId,
        isDeletion: true, // Add a flag to indicate deletion
        currency: existing.currency,
        country: existing.account?.countryId,
        categoryType: existing.category?.type,
        categoryGroup: existing.category?.group,
      });
    }

    res.status(StatusCodes.NO_CONTENT).end();
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Failed to delete transaction',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}
