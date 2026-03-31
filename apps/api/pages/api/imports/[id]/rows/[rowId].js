import { StatusCodes } from 'http-status-codes';
import prisma from '../../../../../prisma/prisma.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { cors } from '../../../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../../../utils/withAuth.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const BACKEND_API_KEY = process.env.INTERNAL_API_KEY;

const ALLOWED_STATUS_OVERRIDES = ['CONFIRMED', 'SKIPPED', 'PENDING'];

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsRead(req, res, (result) => {
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

    const { id: stagedImportId, rowId } = req.query;

    // Validate row belongs to this import and import belongs to tenant
    const row = await prisma.stagedImportRow.findUnique({
      where: { id: rowId },
      include: {
        stagedImport: {
          select: { id: true, tenantId: true, status: true },
        },
      },
    });

    if (!row) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Row not found' });
    }
    if (row.stagedImport.tenantId !== user.tenantId) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Row not found' });
    }
    if (row.stagedImportId !== stagedImportId) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Row does not belong to this import' });
    }
    if (row.stagedImport.status === 'COMMITTED') {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Cannot modify rows of a committed import' });
    }
    if (row.stagedImport.status === 'CANCELLED') {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Cannot modify rows of a cancelled import' });
    }

    // Build update payload
    const { suggestedCategoryId, status, details, ticker, assetQuantity, assetPrice, accountId, isin, exchange, assetCurrency, tags } = req.body;
    const updateData = {};

    // Details override
    if (details !== undefined) {
      updateData.details = details === null ? null : String(details);
    }

    // Investment enrichment fields
    // Validate ticker contains at least one letter — reject pure numeric placeholders like "0"
    if (ticker !== undefined) {
      const tickerStr = ticker === null ? null : String(ticker).trim();
      updateData.ticker = tickerStr && /[a-zA-Z]/.test(tickerStr) ? tickerStr : null;
    }
    if (assetQuantity !== undefined) {
      updateData.assetQuantity = assetQuantity === null ? null : parseFloat(assetQuantity);
    }
    if (assetPrice !== undefined) {
      updateData.assetPrice = assetPrice === null ? null : parseFloat(assetPrice);
    }

    // Ticker resolution metadata (Sprint 14)
    if (isin !== undefined) {
      updateData.isin = isin === null ? null : String(isin);
    }
    if (exchange !== undefined) {
      updateData.exchange = exchange === null ? null : String(exchange);
    }
    if (assetCurrency !== undefined) {
      updateData.assetCurrency = assetCurrency === null ? null : String(assetCurrency);
    }

    // Account override (for native adapter unresolved accounts)
    if (accountId !== undefined) {
      const parsedAccountId = parseInt(accountId, 10);
      if (isNaN(parsedAccountId)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid accountId' });
      }
      // Validate account belongs to tenant
      const account = await prisma.account.findFirst({
        where: { id: parsedAccountId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!account) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Account not found or does not belong to your tenant' });
      }
      updateData.accountId = parsedAccountId;
    }

    // Category override
    if (suggestedCategoryId !== undefined) {
      const categoryId = parseInt(suggestedCategoryId, 10);
      if (isNaN(categoryId)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid suggestedCategoryId' });
      }

      // Validate category belongs to tenant
      const category = await prisma.category.findFirst({
        where: { id: categoryId, tenantId: user.tenantId },
        select: { id: true, type: true, processingHint: true },
      });
      if (!category) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Category not found or does not belong to your tenant' });
      }

      updateData.suggestedCategoryId = categoryId;
      updateData.classificationSource = 'USER_OVERRIDE';

      // Detect whether the new category requires mandatory investment enrichment
      const MANDATORY_HINTS = ['API_STOCK', 'API_CRYPTO', 'API_FUND'];
      const isMandatoryInvestment =
        category.type === 'Investments' && MANDATORY_HINTS.includes(category.processingHint);

      if (isMandatoryInvestment) {
        // Check if enrichment data is present (from this request or existing row)
        const effectiveTicker = updateData.ticker !== undefined ? updateData.ticker : row.ticker;
        const effectiveQty = updateData.assetQuantity !== undefined ? updateData.assetQuantity : row.assetQuantity;
        const effectivePrice = updateData.assetPrice !== undefined ? updateData.assetPrice : row.assetPrice;
        if (!effectiveTicker || effectiveQty == null || effectivePrice == null) {
          updateData.requiresEnrichment = true;
          updateData.enrichmentType = 'INVESTMENT';
        } else {
          updateData.requiresEnrichment = false;
        }
      } else if (row.requiresEnrichment) {
        // Changing FROM investment to non-investment — clear the flag
        updateData.requiresEnrichment = false;
        updateData.enrichmentType = null;
      }
    } else {
      // No category change — if all investment fields are now present, clear the enrichment flag.
      // Merge current update with existing row data so partial updates still clear the flag correctly.
      const effectiveTicker = updateData.ticker !== undefined ? updateData.ticker : row.ticker;
      const effectiveQty = updateData.assetQuantity !== undefined ? updateData.assetQuantity : row.assetQuantity;
      const effectivePrice = updateData.assetPrice !== undefined ? updateData.assetPrice : row.assetPrice;
      if (effectiveTicker && effectiveQty != null && effectivePrice != null) {
        updateData.requiresEnrichment = false;
      }
    }

    // Tags override (array of tag name strings or null to clear)
    if (tags !== undefined) {
      if (tags === null) {
        updateData.tags = null;
      } else if (Array.isArray(tags)) {
        const validTags = tags
          .filter((t) => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim());
        updateData.tags = validTags.length > 0 ? validTags : null;
      } else {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'tags must be an array of strings or null' });
      }
    }

    // Status override
    if (status !== undefined) {
      if (!ALLOWED_STATUS_OVERRIDES.includes(status)) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: `status must be one of: ${ALLOWED_STATUS_OVERRIDES.join(', ')}`,
        });
      }
      updateData.status = status;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'No update fields provided' });
    }

    const updatedRow = await prisma.stagedImportRow.update({
      where: { id: rowId },
      data: updateData,
    });

    // Fire-and-forget feedback to backend when user overrides category
    if (updateData.classificationSource === 'USER_OVERRIDE' && updatedRow.description) {
      fetch(`${BACKEND_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': BACKEND_API_KEY },
        body: JSON.stringify({
          description: updatedRow.description,
          categoryId: updatedRow.suggestedCategoryId,
          tenantId: user.tenantId,
        }),
      }).catch(() => {}); // Non-fatal
    }

    return res.status(StatusCodes.OK).json({ row: updatedRow });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      details: error.message,
    });
  }
});
