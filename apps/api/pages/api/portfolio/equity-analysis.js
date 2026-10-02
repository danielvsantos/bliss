import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { Decimal } from '@prisma/client/runtime/library';
import { withAuth } from '../../../utils/withAuth.js';
import { calculateAssetCurrentValue } from '../../../services/valuation.service.js';
import { convertCurrency } from '../../../utils/currencyConversion.js';
import {
  classifyAssetClass,
  normalizeEtfComposition,
  lookThrough,
  DIVERSIFIED,
} from '@bliss/shared/portfolio';

const VALID_GROUP_BY = ['sector', 'industry', 'country', 'assetClass'];
const GROUPINGS = VALID_GROUP_BY;

// ETFs (Passive Income #77): Twelve Data's profile sector/industry/country are
// empty for US ETFs and misleading for UCITS ones, so an ETF's own sector,
// industry and country are always "Diversified". Since #79 the sector and
// country views look through ETFs using SecurityMaster.etfComposition.
const isEtf = (sm) => typeof sm?.assetType === 'string' && sm.assetType.trim().toUpperCase() === 'ETF';

// Classes the shared look-through places by the holding's own sector/country
// or splits; anything else in the equity list (e.g. a stock overridden to a
// bond) is placed by its own attributes like OTHER.
const LOOK_THROUGH_CLASSES = new Set(['STOCK', 'REIT', 'FUND', 'OTHER', 'INDEX_ETF', 'SECTOR_ETF', 'BOND_ETF']);

const EQUITY_HINTS = ['API_STOCK', 'API_FUND'];
const round2 = (n) => Math.round(n * 100) / 100;

/** Asset class input for the shared classifier. */
function classifierInput(item, sm) {
  return {
    override: item.assetClassOverride,
    processingHint: item.category?.processingHint,
    defaultCategoryCode: item.category?.defaultCategoryCode,
    categoryGroup: item.category?.group,
    security: sm ? { assetType: sm.assetType, name: sm.name, composition: sm.etfComposition } : null,
    incomeTerms: item.incomeTerms,
  };
}

/** Group holdings for one dimension. Group holdings reference the merged rows. */
function groupHoldings(holdings, dimension, totalEquityValue, enabled) {
  let raw;
  if (dimension === 'assetClass') {
    const map = new Map();
    holdings.forEach((h, index) => {
      const g = map.get(h.assetClass) || { name: h.assetClass, value: 0, holdings: [] };
      g.value += h.currentValue;
      g.holdings.push({ index, value: h.currentValue });
      map.set(h.assetClass, g);
    });
    raw = [...map.values()].sort((a, b) => b.value - a.value);
  } else {
    raw = lookThrough(
      holdings.map((h) => ({
        value: h.currentValue,
        assetClass: LOOK_THROUGH_CLASSES.has(h.assetClass) ? h.assetClass : 'OTHER',
        isEtf: h.assetType === 'ETF',
        sector: h.sector,
        industry: h.industry,
        country: h.country,
        composition: h.composition,
      })),
      dimension,
      { enabled },
    );
  }
  return raw.map((g) => ({
    name: g.name,
    totalValue: round2(g.value),
    weight: totalEquityValue > 0 ? g.value / totalEquityValue : 0,
    holdingsCount: g.holdings.length,
    holdings: g.holdings.map(({ index }) => holdings[index]),
  }));
}

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
    const lookThroughEnabled = req.query.lookThrough !== 'false';

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
          processingHint: { in: EQUITY_HINTS },
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
        assetClassOverride: true,
        category: {
          select: {
            name: true,
            group: true,
            processingHint: true,
            defaultCategoryCode: true,
          },
        },
        incomeTerms: {
          select: {
            incomeType: true,
            isDistributing: true,
            dividendPerUnit: true,
            currency: true,
            issuerType: true,
          },
        },
      },
      orderBy: { symbol: 'asc' },
    });

    // 2. Fetch SecurityMaster data for all stock/fund symbols
    const candidateSymbols = [...new Set(candidateItems.map((item) => item.symbol))];
    const securityMasterRecords = candidateSymbols.length
      ? await prisma.securityMaster.findMany({ where: { symbol: { in: candidateSymbols } } })
      : [];
    const smMap = Object.fromEntries(securityMasterRecords.map((r) => [r.symbol, r]));

    // API_FUND items are kept in the equity views only when SecurityMaster
    // identifies them as ETFs.
    const stockItems = candidateItems.filter(
      (item) => item.category?.processingHint === 'API_STOCK' || isEtf(smMap[item.symbol]),
    );

    // Funds left out only because SecurityMaster has no row for them yet (a new
    // buy before refresh-tenant-securities has run, or no Twelve Data key), so
    // we can't tell an ETF from a mutual fund. Ticker-less (MANUAL) funds are
    // never looked up, so they are not pending.
    const pendingSecuritySymbols = [...new Set(
      candidateItems
        .filter((item) => item.category?.processingHint === 'API_FUND' && item.source !== 'MANUAL' && !smMap[item.symbol])
        .map((item) => item.symbol),
    )];

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
        const classInput = classifierInput(item, smMap[item.symbol]);
        const { assetClass, source: assetClassSource } = classifyAssetClass(classInput);
        const autoAssetClass = classifyAssetClass({ ...classInput, override: null }).assetClass;
        const composition = etf ? normalizeEtfComposition(sm.etfComposition) : null;

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

        const currentValue = parseFloat(marketValuePC.toString());

        return {
          id: item.id,
          symbol: item.symbol,
          name: sm.name || item.symbol,
          assetType: etf ? 'ETF' : 'STOCK',
          assetClass,
          assetClassSource,
          autoAssetClass,
          composition,
          quantity: parseFloat(quantity.toString()),
          currentValue,
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
    //     identical across accounts — we just sum the financial values. The
    //     asset class override is set per symbol, so an OVERRIDE wins the merge.
    const symbolMap = new Map();
    for (const { id, ...h } of enrichedHoldings) {
      if (symbolMap.has(h.symbol)) {
        const existing = symbolMap.get(h.symbol);
        existing.itemIds.push(id);
        existing.quantity += h.quantity;
        existing.currentValue += h.currentValue;
        existing.currentValueUSD += h.currentValueUSD;
        if (h.assetClassSource === 'OVERRIDE' && existing.assetClassSource !== 'OVERRIDE') {
          existing.assetClass = h.assetClass;
          existing.assetClassSource = h.assetClassSource;
        }
        if (existing.annualDividendUSD != null || h.annualDividendUSD != null) {
          existing.annualDividendUSD = (existing.annualDividendUSD || 0) + (h.annualDividendUSD || 0);
          existing.dividendYield = existing.currentValueUSD > 0
            ? existing.annualDividendUSD / existing.currentValueUSD
            : null;
        }
      } else {
        symbolMap.set(h.symbol, { ...h, itemIds: [id] });
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

    // 5. Compute weighted P/E and dividend yield (unchanged by look-through)
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

    // 6. Group by every dimension. Sector and country look through ETFs
    //    (unless lookThrough=false); an ETF can then sit in several groups, so
    //    the flat `holdings` list is the one to render rows from.
    const groupings = Object.fromEntries(
      GROUPINGS.map((dim) => [dim, groupHoldings(mergedHoldings, dim, totalEquityValue, lookThroughEnabled)]),
    );
    const holdings = [...mergedHoldings].sort((a, b) => b.currentValue - a.currentValue);

    res.status(StatusCodes.OK).json({
      portfolioCurrency,
      lookThrough: lookThroughEnabled,
      // True when at least one ETF has composition data to look through. The
      // web hides the "Look through ETFs" switch otherwise (e.g. when the
      // Twelve Data plan doesn't include /etfs/world/composition).
      lookThroughAvailable: mergedHoldings.some(
        (h) => h.composition && (h.composition.sectors.length > 0 || h.composition.countries.length > 0),
      ),
      summary: {
        totalEquityValue: round2(totalEquityValue),
        holdingsCount: mergedHoldings.length,
        weightedPeRatio,
        weightedDividendYield,
      },
      // Funds missing from these views until their security data is fetched.
      pendingSecurityData: {
        count: pendingSecuritySymbols.length,
        symbols: pendingSecuritySymbols,
      },
      groups: groupings[groupBy],
      groupings,
      holdings,
    });
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
