import prisma from '../../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../utils/cors.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { Decimal } from '@prisma/client/runtime/library';
import { withAuth } from '../../../../../utils/withAuth.js';

import { produceEvent } from '../../../../../utils/produceEvent.js';
import { eventOrigin } from '../../../../../utils/eventOrigin.js';

// #93 D5: hints priced from market data. API_STOCK and API_CRYPTO never read
// manual values, and API_FUND only falls back to them after the live API and
// the 7-day price lookback both fail, so a manual value on a ticker-backed
// item is ignored. Ticker-less funds (source MANUAL) are priced from manual
// values and stay allowed.
const MARKET_PRICED_HINTS = new Set(['API_STOCK', 'API_CRYPTO', 'API_FUND']);

export default withAuth(async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.assetprice(req, res, (result) => {
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
      default:
        res.setHeader('Allow', ['GET', 'POST']);
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
  const { tenantId } = req.user;
  const { assetId } = req.query;
  const portfolioItemId = parseInt(assetId, 10);

  if (isNaN(portfolioItemId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid Portfolio Item ID' });
  }

  try {
    const values = await prisma.manualAssetValue.findMany({
      where: {
        assetId: portfolioItemId,
        tenantId: tenantId,
      },
      orderBy: {
        date: 'desc',
      },
    });
    res.status(StatusCodes.OK).json(values);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to retrieve manual values' });
  }
}

async function handlePost(req, res) {
  const { tenantId, email: userEmail } = req.user;
  const { assetId } = req.query;
  const portfolioItemId = parseInt(assetId, 10);
  const { date, value, currency, notes } = req.body;

  if (isNaN(portfolioItemId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid Portfolio Item ID' });
  }

  if (!date || !value || !currency) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing required fields: date, value, currency' });
  }

  try {
    // Verify the asset belongs to the tenant
    const asset = await prisma.portfolioItem.findFirst({
      where: { id: portfolioItemId, tenantId },
      include: { category: { select: { processingHint: true } } },
    });
    if (!asset) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'Portfolio item not found in this tenant' });
    }
    if (MARKET_PRICED_HINTS.has(asset.category?.processingHint) && asset.source !== 'MANUAL') {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'This holding is priced from market data, so a manual value would be ignored. Manual values are for manually priced assets.',
        code: 'MARKET_PRICED_ASSET',
      });
    }

    const result = await prisma.$transaction(async (prisma) => {
      const newValue = await prisma.manualAssetValue.create({
        data: {
          assetId: portfolioItemId,
          tenantId,
          date: new Date(date),
          value: new Decimal(value),
          currency,
          notes,
        },
        // `value` is a per-unit price; the current quantity lets callers check the implied total.
        include: { asset: { select: { quantity: true } } },
      });

      return newValue;
    });

    // Produce event after successful creation
    await produceEvent({
      ...eventOrigin(req),
      type: 'MANUAL_PORTFOLIO_PRICE_UPDATED',
      portfolioItemId: portfolioItemId,
      tenantId: tenantId,
    });

    res.status(StatusCodes.CREATED).json(result);
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Creation failed', details: error.message });
  }
} 