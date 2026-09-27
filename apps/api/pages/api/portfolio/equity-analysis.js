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

// ETFs (Passive Income #77): Twelve Data's profile sector/industry/country are
// empty for US ETFs and misleading for UCITS ones, so ETFs are always bucketed
// as "Diversified". Look-through by sector comes in #79.
const DIVERSIFIED = 'Diversified';
const isEtf = (sm) => typeof sm?.assetType === 'string' && sm.assetType.trim().toUpperCase() === 'ETF';

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
    const { groupBy = 'sector', accountId } = req.query;

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

    // 1. Fetch stock and fund holdings (API_STOCK / API_FUND with positive
    //    quantity). API_FUND items are kept below only when SecurityMaster
    //    identifies them as ETFs.
    const candidateItems = await prisma.portfolioItem.findMany({
      where: {
        tenantId: req.user.tenantId,
        quantity: { gt: 0 },
        ...(accountId && { accountId: parseInt(accountId, 10) }),
        category: {
          processingHint: { in: ['API_STOCK', 'API_FUND'] },
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
        incomeTerms: {
          select: { incomeType: true, isDistributing: true, dividendPerUnit: true, currency: true },
        },
      },
      orderBy: { symbol: 'asc' },
    });

    // 2. Fetch SecurityMaster data for all candidate symbols
    const candidateSymbols = [...new Set(candidateItems.map((item) => item.symbol))];
    const securityMasterRecords = candidateSymbols.length
      ? await prisma.securityMaster.findMany({ where: { symbol: { in: candidateSymbols } } })
      : [];
    const smMap = Object.fromEntries(securityMasterRecords.map((r) => [r.symbol, r]));

    const stockItems = candidateItems.filter(
      (item) => item.category?.processingHint === 'API_STOCK' || isEtf(smMap[item.symbol]),
    );

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
        const etf = isEtf(sm);

        // Dividend yield, override-aware: a user dividend override
        // (IncomeTerms DIVIDEND with dividendPerUnit) replaces SecurityMaster;
        // "doesn't distribute" means zero. Carried as an annual USD amount so
        // same-symbol holdings merge correctly below.
        const terms = item.incomeTerms;
        const valueUSD = parseFloat(marketValueUSD.toString());
        let annualDividendUSD = null;
        if (terms && (terms.isDistributing === false || terms.incomeType === 'NONE')) {
          annualDividendUSD = 0;
        } else if (terms?.incomeType === 'DIVIDEND' && terms.dividendPerUnit != null) {
          const nativeAnnual = new Decimal(terms.dividendPerUnit).times(quantity);
          const termsCurrency = terms.currency || item.currency;
          const converted = termsCurrency === 'USD'
            ? nativeAnnual
            : await convertCurrency(nativeAnnual, termsCurrency, 'USD');
          annualDividendUSD = parseFloat((converted || nativeAnnual).toString());
        } else if (sm.dividendTrusted && sm.dividendYield != null) {
          annualDividendUSD = parseFloat(sm.dividendYield.toString()) * valueUSD;
        }

        return {
          symbol: item.symbol,
          name: sm.name || item.symbol,
          assetType: etf ? 'ETF' : 'STOCK',
          quantity: parseFloat(quantity.toString()),
          currentValue: parseFloat(marketValuePC.toString()),
          currentValueUSD: valueUSD,
          sector: etf ? DIVERSIFIED : (sm.sector || 'Unknown'),
          industry: etf ? DIVERSIFIED : (sm.industry || 'Unknown'),
          country: etf ? DIVERSIFIED : (sm.country || 'Unknown'),
          // Trust gate: hide earnings/dividend fields when Twelve Data
          // returned inconsistent data (see SecurityMaster.earningsTrusted /
          // dividendTrusted, populated by upsertFundamentals). The frontend
          // already renders null as `—`, so the user sees missing data
          // instead of wrong data.
          // P/E and EPS stay stock-only: ETF earnings are meaningless.
          peRatio: !etf && sm.earningsTrusted && sm.peRatio ? parseFloat(sm.peRatio.toString()) : null,
          dividendYield: annualDividendUSD != null && valueUSD > 0 ? annualDividendUSD / valueUSD : null,
          trailingEps: !etf && sm.earningsTrusted && sm.trailingEps ? parseFloat(sm.trailingEps.toString()) : null,
          latestEpsActual: !etf && sm.earningsTrusted && sm.latestEpsActual ? parseFloat(sm.latestEpsActual.toString()) : null,
          latestEpsSurprise: !etf && sm.earningsTrusted && sm.latestEpsSurprise ? parseFloat(sm.latestEpsSurprise.toString()) : null,
          week52High: sm.week52High ? parseFloat(sm.week52High.toString()) : null,
          week52Low: sm.week52Low ? parseFloat(sm.week52Low.toString()) : null,
          averageVolume: sm.averageVolume ? parseFloat(sm.averageVolume.toString()) : null,
          logoUrl: sm.logoUrl || null,
          annualDividendUSD,
          weight: 0, // computed below
        };
      })
    );

    // 3b. Merge entries for the same symbol held across multiple accounts.
    //     SecurityMaster data (sector, P/E, etc.) is per-symbol so it is
    //     identical across accounts — we just sum the financial values.
    const symbolMap = new Map();
    for (const h of enrichedHoldings) {
      if (symbolMap.has(h.symbol)) {
        const existing = symbolMap.get(h.symbol);
        existing.quantity += h.quantity;
        existing.currentValue += h.currentValue;
        existing.currentValueUSD += h.currentValueUSD;
        if (existing.annualDividendUSD != null || h.annualDividendUSD != null) {
          existing.annualDividendUSD = (existing.annualDividendUSD || 0) + (h.annualDividendUSD || 0);
          existing.dividendYield = existing.currentValueUSD > 0
            ? existing.annualDividendUSD / existing.currentValueUSD
            : null;
        }
      } else {
        symbolMap.set(h.symbol, { ...h });
      }
    }
    const mergedHoldings = [...symbolMap.values()].map(({ annualDividendUSD, ...h }) => ({
      ...h,
      dividendYield: h.dividendYield != null ? Math.round(h.dividendYield * 1e6) / 1e6 : null,
    }));

    // 4. Compute total equity value and weights
    const totalEquityValue = mergedHoldings.reduce((sum, h) => sum + h.currentValue, 0);

    for (const h of mergedHoldings) {
      h.weight = totalEquityValue > 0 ? h.currentValue / totalEquityValue : 0;
    }

    // 5. Compute weighted P/E and dividend yield
    let weightedPeRatio = null;
    let weightedDividendYield = null;

    const holdingsWithPe = mergedHoldings.filter((h) => h.peRatio != null && h.peRatio > 0);
    if (holdingsWithPe.length > 0) {
      const peWeightSum = holdingsWithPe.reduce((sum, h) => sum + h.weight, 0);
      if (peWeightSum > 0) {
        weightedPeRatio = holdingsWithPe.reduce((sum, h) => sum + h.peRatio * (h.weight / peWeightSum), 0);
        weightedPeRatio = Math.round(weightedPeRatio * 100) / 100;
      }
    }

    const holdingsWithYield = mergedHoldings.filter((h) => h.dividendYield != null && h.dividendYield > 0);
    if (holdingsWithYield.length > 0) {
      const yieldWeightSum = holdingsWithYield.reduce((sum, h) => sum + h.weight, 0);
      if (yieldWeightSum > 0) {
        weightedDividendYield = holdingsWithYield.reduce((sum, h) => sum + h.dividendYield * (h.weight / yieldWeightSum), 0);
        weightedDividendYield = Math.round(weightedDividendYield * 1000000) / 1000000;
      }
    }

    // 6. Group by requested field
    const groupMap = {};
    for (const h of mergedHoldings) {
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
        holdingsCount: mergedHoldings.length,
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
