import prisma from '../../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../utils/cors.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { withAuth } from '../../../../../utils/withAuth.js';
import { ASSET_CLASSES, classifyAssetClass, isValidAssetClass } from '@bliss/shared/portfolio';

/**
 * Asset class override for one portfolio item (Equity Analysis, #79).
 *
 *   PUT { assetClass: AssetClass | null, applyToSymbol?: boolean }
 *     → { assetClass, assetClassSource, autoAssetClass, updatedCount }
 *
 * `null` clears the override (back to automatic). `applyToSymbol: true` sets
 * the same override on every holding of the same symbol in the tenant —
 * Equity Analysis merges those into one row.
 *
 * No background job: Equity Analysis classifies on read.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'PUT') {
    res.setHeader('Allow', ['PUT']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  const portfolioItemId = parseInt(req.query.assetId, 10);
  if (Number.isNaN(portfolioItemId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid Portfolio Item ID' });
  }

  const { assetClass, applyToSymbol = false } = req.body || {};
  if (assetClass !== null && !isValidAssetClass(assetClass)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: `Invalid assetClass. Must be null or one of: ${ASSET_CLASSES.join(', ')}`,
    });
  }

  try {
    const tenantId = req.user.tenantId;
    const item = await prisma.portfolioItem.findFirst({
      where: { id: portfolioItemId, tenantId },
      select: {
        id: true,
        symbol: true,
        category: { select: { group: true, processingHint: true, defaultCategoryCode: true } },
        incomeTerms: { select: { issuerType: true, incomeType: true } },
      },
    });
    if (!item) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Portfolio item not found' });
    }

    const where = applyToSymbol === true ? { tenantId, symbol: item.symbol } : { tenantId, id: item.id };
    const { count } = await prisma.portfolioItem.updateMany({ where, data: { assetClassOverride: assetClass } });

    const security = await prisma.securityMaster.findUnique({
      where: { symbol: item.symbol },
      select: { assetType: true, name: true, etfComposition: true },
    });
    const input = {
      processingHint: item.category?.processingHint,
      defaultCategoryCode: item.category?.defaultCategoryCode,
      categoryGroup: item.category?.group,
      security: security ? { ...security, composition: security.etfComposition } : null,
      incomeTerms: item.incomeTerms,
    };
    const result = classifyAssetClass({ ...input, override: assetClass });
    const auto = classifyAssetClass(input);

    return res.status(StatusCodes.OK).json({
      assetClass: result.assetClass,
      assetClassSource: result.source,
      autoAssetClass: auto.assetClass,
      updatedCount: count,
    });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
