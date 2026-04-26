import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { Decimal } from '@prisma/client/runtime/library';
import { withAuth } from '../../../utils/withAuth.js';
import { calculateAssetCurrentValue } from '../../../services/valuation.service.js';
import { convertCurrency } from '../../../utils/currencyConversion.js';

const VALID_GROUP_BY = ['sector', 'industry', 'country'];

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.portfolio(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const { groupBy = 'sector' } = req.query;

    if (!VALID_GROUP_BY.includes(groupBy)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: `Invalid groupBy value. Must be one of: ${VALID_GROUP_BY.join(', ')}`,
      });
    }

    // Fetch tenant's portfolio currency
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { portfolioCurrency: true },
    });
    const portfolioCurrency = tenant?.portfolioCurrency || 'USD';

    // 1. Fetch stock-only holdings (API_STOCK with positive quantity)
    const stockItems = await prisma.portfolioItem.findMany({
      where: {
        tenantId: req.user.tenantId,
        quantity: { gt: 0 },
        category: {
          processingHint: 'API_STOCK',
        },
      },
      select: {
        id: true,
        symbol: true,
        currency: true,
        assetCurrency: true,
        quantity: true,
        costBasis: true,
        currentValue: true,
        costBasisInUSD: true,
        currentValueInUSD: true,
        source: true,
        category: {
          select: {
            name: true,
            group: true,
            processingHint: true,
          },
        },
      },
      orderBy: { symbol: 'asc' },
    });

    if (stockItems.length === 0) {
      return res.status(StatusCodes.OK).json({
        portfolioCurrency,
        summary: {
          totalEquityValue: 0,
          holdingsCount: 0,
          weightedPeRatio: null,
          weightedDividendYield: null,
        },
        groups: [],
      });
    }

    // 2. Fetch SecurityMaster data for all symbols
    const symbols = [...new Set(stockItems.map((item) => item.symbol))];
    const securityMasterRecords = await prisma.securityMaster.findMany({
      where: { symbol: { in: symbols } },
    });
    const smMap = Object.fromEntries(securityMasterRecords.map((r) => [r.symbol, r]));

    // 3. Enrich holdings with live prices and SecurityMaster data
    const enrichedHoldings = await Promise.all(
      stockItems.map(async (item) => {
        const quantity = new Decimal(item.quantity || 0);
        let marketValueUSD = new Decimal(item.currentValueInUSD || 0);

        // Fetch live price for non-manual items
        if (item.source !== 'MANUAL' && quantity.gt(0)) {
          try {
            const livePricePerUnit = await calculateAssetCurrentValue(item);
            const priceCurrency = item.assetCurrency || item.currency;
            const marketValueInPriceCurrency = livePricePerUnit.times(quantity);

            if (priceCurrency === 'USD') {
              marketValueUSD = marketValueInPriceCurrency;
            } else {
              const converted = await convertCurrency(marketValueInPriceCurrency, priceCurrency, 'USD');
              marketValueUSD = converted || marketValueInPriceCurrency;
            }
          } catch {
            // Fall back to stored value on live price failure
          }
        }

        // Portfolio currency conversion
        let marketValuePC = marketValueUSD;
        if (portfolioCurrency !== 'USD') {
          const converted = await convertCurrency(marketValueUSD, 'USD', portfolioCurrency);
          if (converted) marketValuePC = converted;
        }

        const sm = smMap[item.symbol] || {};

        return {
          symbol: item.symbol,
          name: sm.name || item.symbol,
          quantity: parseFloat(quantity.toString()),
          currentValue: parseFloat(marketValuePC.toString()),
          currentValueUSD: parseFloat(marketValueUSD.toString()),
          sector: sm.sector || 'Unknown',
          industry: sm.industry || 'Unknown',
          country: sm.country || 'Unknown',
          // Trust gate: hide earnings/dividend fields when Twelve Data
          // returned inconsistent data (see SecurityMaster.earningsTrusted /
          // dividendTrusted, populated by upsertFundamentals). The frontend
          // already renders null as `—`, so the user sees missing data
          // instead of wrong data.
          peRatio: sm.earningsTrusted && sm.peRatio ? parseFloat(sm.peRatio.toString()) : null,
          dividendYield: sm.dividendTrusted && sm.dividendYield ? parseFloat(sm.dividendYield.toString()) : null,
          trailingEps: sm.earningsTrusted && sm.trailingEps ? parseFloat(sm.trailingEps.toString()) : null,
          latestEpsActual: sm.earningsTrusted && sm.latestEpsActual ? parseFloat(sm.latestEpsActual.toString()) : null,
          latestEpsSurprise: sm.earningsTrusted && sm.latestEpsSurprise ? parseFloat(sm.latestEpsSurprise.toString()) : null,
          week52High: sm.week52High ? parseFloat(sm.week52High.toString()) : null,
          week52Low: sm.week52Low ? parseFloat(sm.week52Low.toString()) : null,
          averageVolume: sm.averageVolume ? parseFloat(sm.averageVolume.toString()) : null,
          logoUrl: sm.logoUrl || null,
          weight: 0, // computed below
        };
      })
    );

    // 4. Compute total equity value and weights
    const totalEquityValue = enrichedHoldings.reduce((sum, h) => sum + h.currentValue, 0);

    for (const h of enrichedHoldings) {
      h.weight = totalEquityValue > 0 ? h.currentValue / totalEquityValue : 0;
    }

    // 5. Compute weighted P/E and dividend yield
    let weightedPeRatio = null;
    let weightedDividendYield = null;

    const holdingsWithPe = enrichedHoldings.filter((h) => h.peRatio != null && h.peRatio > 0);
    if (holdingsWithPe.length > 0) {
      const peWeightSum = holdingsWithPe.reduce((sum, h) => sum + h.weight, 0);
      if (peWeightSum > 0) {
        weightedPeRatio = holdingsWithPe.reduce((sum, h) => sum + h.peRatio * (h.weight / peWeightSum), 0);
        weightedPeRatio = Math.round(weightedPeRatio * 100) / 100;
      }
    }

    const holdingsWithYield = enrichedHoldings.filter((h) => h.dividendYield != null && h.dividendYield > 0);
    if (holdingsWithYield.length > 0) {
      const yieldWeightSum = holdingsWithYield.reduce((sum, h) => sum + h.weight, 0);
      if (yieldWeightSum > 0) {
        weightedDividendYield = holdingsWithYield.reduce((sum, h) => sum + h.dividendYield * (h.weight / yieldWeightSum), 0);
        weightedDividendYield = Math.round(weightedDividendYield * 1000000) / 1000000;
      }
    }

    // 6. Group by requested field
    const groupMap = {};
    for (const h of enrichedHoldings) {
      const key = h[groupBy] || 'Unknown';
      if (!groupMap[key]) {
        groupMap[key] = { name: key, totalValue: 0, holdingsCount: 0, holdings: [] };
      }
      groupMap[key].totalValue += h.currentValue;
      groupMap[key].holdingsCount += 1;
      groupMap[key].holdings.push(h);
    }

    const groups = Object.values(groupMap)
      .map((g) => ({
        ...g,
        weight: totalEquityValue > 0 ? g.totalValue / totalEquityValue : 0,
        totalValue: Math.round(g.totalValue * 100) / 100,
      }))
      .sort((a, b) => b.totalValue - a.totalValue);

    res.status(StatusCodes.OK).json({
      portfolioCurrency,
      summary: {
        totalEquityValue: Math.round(totalEquityValue * 100) / 100,
        holdingsCount: enrichedHoldings.length,
        weightedPeRatio,
        weightedDividendYield,
      },
      groups,
    });
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
