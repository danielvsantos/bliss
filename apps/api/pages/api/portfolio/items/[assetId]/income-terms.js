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
  resolveIncomeSource,
} from '@bliss/shared/portfolio';
import { validateBody, toIncomeTermsData, serializeIncomeTerms } from '../../../../../services/incomeTerms.service.js';

/**
 * Income terms for one portfolio item (Passive Income, #77).
 *
 *   GET    → { asset, terms, auto, siblings }   auto = trusted SecurityMaster dividend
 *            data (stocks/ETFs); siblings = every open holding of the same symbol
 *            and asset class in the tenant (this one included), for group editing (#83)
 *   PUT    → upsert, validated per incomeType. `applyToSymbol: true` writes the
 *            same terms to every sibling (any income type except cash INTEREST,
 *            which is set per account); each target keeps its own currency.
 *   DELETE → removes the terms (stocks/ETFs fall back to automatic data).
 *            `?applyToSymbol=true` removes them from every holding of the symbol.
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

const CASH_PER_ACCOUNT = 'Cash interest is set per account';

/**
 * Holdings of the same symbol and asset class in the tenant (the item itself
 * included). The asset-class check keeps an oddly named manual asset out of a
 * security's group. `openOnly` limits it to open positions (quantity > 0),
 * which is what the grouped breakdown shows; the item itself is always kept.
 */
async function findSiblings(tenantId, item, assetClass, sm, { openOnly = true } = {}) {
  const rows = await prisma.portfolioItem.findMany({
    where: {
      tenantId,
      symbol: item.symbol,
      ...(openOnly && { OR: [{ quantity: { gt: 0 } }, { id: item.id }] }),
    },
    include: {
      category: {
        select: { name: true, type: true, group: true, processingHint: true, defaultCategoryCode: true },
      },
      account: { select: { name: true } },
      incomeTerms: true,
    },
    orderBy: { id: 'asc' },
  });
  return rows.filter(
    (r) => classifyIncomeAsset({ ...r.category, securityAssetType: sm?.assetType }) === assetClass,
  );
}

function trustedDividends(sm) {
  return sm?.dividendTrusted ? (Array.isArray(sm.recentDividends) ? sm.recentDividends : []) : null;
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
  const siblings = assetClass ? await findSiblings(req.user.tenantId, item, assetClass, sm) : [item];
  const recentDividends = trustedDividends(sm);

  return res.status(StatusCodes.OK).json({
    asset: {
      id: item.id,
      symbol: item.symbol,
      currency: item.currency,
      quantity: Number(item.quantity.toString()),
      // What was paid (item currency) — the modal defaults a bond's total face value to it.
      costBasis: item.costBasis != null ? Number(item.costBasis.toString()) : null,
      categoryName: item.category.name,
      assetClass,
      defaultIncomeType: assetClass ? DEFAULT_INCOME_TYPE_BY_CLASS[assetClass] : null,
    },
    terms: serializeIncomeTerms(item.incomeTerms),
    auto: autoDividendView(sm),
    siblings: siblings.map((r) => ({
      assetId: r.id,
      accountName: r.account?.name ?? null,
      currency: r.currency,
      quantity: Number(r.quantity.toString()),
      costBasis: r.costBasis != null ? Number(r.costBasis.toString()) : null,
      terms: serializeIncomeTerms(r.incomeTerms),
      source: assetClass
        ? resolveIncomeSource({ assetClass, terms: r.incomeTerms, recentDividends })
        : 'MISSING',
    })),
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

  const applyToSymbol = body.applyToSymbol === true;
  if (applyToSymbol && (body.incomeType === 'INTEREST' || assetClass === 'CASH')) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: CASH_PER_ACCOUNT });
  }

  const data = toIncomeTermsData(body);
  const bodyCurrency = data.currency;
  // Assets never carry a stream name.
  data.name = null;

  const targets = applyToSymbol
    ? await findSiblings(tenantId, item, assetClass, sm)
    : [item];

  const rows = await prisma.$transaction(
    targets.map((target) => {
      // Without an explicit currency each holding keeps its own (#83).
      const row = { ...data, currency: bodyCurrency || target.currency };
      return prisma.incomeTerms.upsert({
        where: { assetId: target.id },
        update: { ...row, orphanedAt: null, orphanedLabel: null, categoryId: null },
        create: { ...row, tenantId, assetId: target.id },
      });
    }),
  );
  const targetIds = targets.map((t) => t.id);

  const own = rows.find((r) => r.assetId === id) || rows[0];
  return res.status(StatusCodes.OK).json({
    terms: serializeIncomeTerms(own),
    appliedTo: targetIds,
  });
}

async function handleDelete(req, res, id) {
  const { tenantId } = req.user;
  if (req.query.applyToSymbol === 'true') {
    const item = await loadItem(tenantId, id);
    if (!item) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Portfolio item not found' });
    const sm = await prisma.securityMaster.findUnique({
      where: { symbol: item.symbol },
      select: { assetType: true },
    });
    const assetClass = classifyIncomeAsset({ ...item.category, securityAssetType: sm?.assetType });
    if (assetClass === 'CASH') return res.status(StatusCodes.BAD_REQUEST).json({ error: CASH_PER_ACCOUNT });
    const targets = assetClass
      ? await findSiblings(tenantId, item, assetClass, sm, { openOnly: false })
      : [item];
    const { count } = await prisma.incomeTerms.deleteMany({
      where: { tenantId, assetId: { in: targets.map((t) => t.id) } },
    });
    return res.status(StatusCodes.OK).json({ deleted: count });
  }

  const { count } = await prisma.incomeTerms.deleteMany({
    where: { assetId: id, tenantId },
  });
  if (count === 0) return res.status(StatusCodes.NOT_FOUND).json({ error: 'Income terms not found' });
  return res.status(StatusCodes.NO_CONTENT).end();
}
