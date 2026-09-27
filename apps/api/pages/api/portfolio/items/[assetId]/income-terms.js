import prisma from '../../../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../../utils/cors.js';
import { rateLimiters } from '../../../../../utils/rateLimit.js';
import { withAuth } from '../../../../../utils/withAuth.js';
import {
  classifyIncomeAsset,
  DEFAULT_INCOME_TYPE_BY_CLASS,
  frequencyFromDividendCount,
} from '@bliss/shared/portfolio';
import { validateBody, toIncomeTermsData, serializeIncomeTerms } from '../../../../../services/incomeTerms.service.js';

/**
 * Income terms for one portfolio item (Passive Income, #77).
 *
 *   GET    → { asset, terms, auto }   auto = trusted SecurityMaster dividend data (stocks/ETFs)
 *   PUT    → upsert, validated per incomeType. `applyToSymbol: true` copies a
 *            dividend override onto every holding of the same symbol in the tenant.
 *   DELETE → removes the terms (stocks/ETFs fall back to automatic data)
 *
 * No background job is triggered: the projection is computed on read.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  const portfolioItemId = parseInt(req.query.assetId, 10);
  if (Number.isNaN(portfolioItemId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid Portfolio Item ID' });
  }

  try {
    switch (req.method) {
      case 'GET':
        return await handleGet(req, res, portfolioItemId);
      case 'PUT':
        return await handlePut(req, res, portfolioItemId);
      case 'DELETE':
        return await handleDelete(req, res, portfolioItemId);
      default:
        res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
        return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
    }
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

async function loadItem(tenantId, id) {
  return prisma.portfolioItem.findFirst({
    where: { id, tenantId },
    include: {
      category: {
        select: { name: true, type: true, group: true, processingHint: true, defaultCategoryCode: true },
      },
      incomeTerms: true,
    },
  });
}

function autoDividendView(sm) {
  if (!sm || !sm.dividendTrusted) return null;
  const recentDividends = Array.isArray(sm.recentDividends) ? sm.recentDividends : [];
  return {
    trusted: true,
    currency: sm.currency || null,
    recentDividends,
    frequency: frequencyFromDividendCount(recentDividends.length),
    annualDividend: sm.annualizedDividend != null ? Number(sm.annualizedDividend.toString()) : null,
    dividendYield: sm.dividendYield != null ? Number(sm.dividendYield.toString()) : null,
    lastUpdated: sm.lastFundamentalsUpdate || null,
  };
}

async function handleGet(req, res, id) {
  const item = await loadItem(req.user.tenantId, id);
  if (!item) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Portfolio item not found' });

  const sm = await prisma.securityMaster.findUnique({ where: { symbol: item.symbol } });
  const assetClass = classifyIncomeAsset({ ...item.category, securityAssetType: sm?.assetType });

  return res.status(StatusCodes.OK).json({
    asset: {
      id: item.id,
      symbol: item.symbol,
      currency: item.currency,
      quantity: Number(item.quantity.toString()),
      categoryName: item.category.name,
      assetClass,
      defaultIncomeType: assetClass ? DEFAULT_INCOME_TYPE_BY_CLASS[assetClass] : null,
    },
    terms: serializeIncomeTerms(item.incomeTerms),
    auto: autoDividendView(sm),
  });
}

async function handlePut(req, res, id) {
  const { tenantId } = req.user;
  const body = req.body || {};
  const invalid = validateBody(body, 'asset');
  if (invalid) return res.status(StatusCodes.BAD_REQUEST).json(invalid);

  const item = await loadItem(tenantId, id);
  if (!item) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Portfolio item not found' });

  const sm = await prisma.securityMaster.findUnique({
    where: { symbol: item.symbol },
    select: { assetType: true },
  });
  const assetClass = classifyIncomeAsset({ ...item.category, securityAssetType: sm?.assetType });
  if (!assetClass) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'This asset cannot hold income terms' });
  }

  const data = toIncomeTermsData(body);
  if (!data.currency) data.currency = item.currency;
  // Assets never carry a stream name.
  data.name = null;

  const applyToSymbol = body.applyToSymbol === true && body.incomeType === 'DIVIDEND';
  const targetIds = applyToSymbol
    ? (await prisma.portfolioItem.findMany({
        where: { tenantId, symbol: item.symbol },
        select: { id: true },
      })).map((r) => r.id)
    : [id];

  const rows = await prisma.$transaction(
    targetIds.map((assetId) =>
      prisma.incomeTerms.upsert({
        where: { assetId },
        update: { ...data, orphanedAt: null, orphanedLabel: null, categoryId: null },
        create: { ...data, tenantId, assetId },
      }),
    ),
  );

  const own = rows.find((r) => r.assetId === id) || rows[0];
  return res.status(StatusCodes.OK).json({
    terms: serializeIncomeTerms(own),
    appliedTo: targetIds,
  });
}

async function handleDelete(req, res, id) {
  const { count } = await prisma.incomeTerms.deleteMany({
    where: { assetId: id, tenantId: req.user.tenantId },
  });
  if (count === 0) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Income terms not found' });
  return res.status(StatusCodes.NO_CONTENT).end();
}
