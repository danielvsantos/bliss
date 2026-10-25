import prisma from '../../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { Decimal } from '@prisma/client/runtime/library';
import { withAuth } from '../../../utils/withAuth.js';
import { calculateAssetCurrentValue } from '../../../services/valuation.service.js';
import { createCurrencyConverter } from '../../../utils/currencyConversion.js';
import { copyTradeStatus, loadCopyLookThrough } from '../../../services/etoro.service.js';
import {
  classifyAssetClass,
  normalizeEtfComposition,
  lookThrough,
  DIVERSIFIED,
  LOOK_THROUGH_OTHER,
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
const LOOK_THROUGH_CLASSES = new Set(['STOCK', 'REIT', 'FUND', 'OTHER', 'INDEX_ETF', 'SECTOR_ETF', 'BOND_ETF', 'COPY_TRADE']);

const EQUITY_HINTS = ['API_STOCK', 'API_FUND'];
// eToro copy trades (#143): looked through like an ETF, from the user's own copy holdings.
const COPY_TRADING_HINT = 'COPY_TRADING';
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
    const add = (name, index, value) => {
      if (!(value > 0)) return;
      const g = map.get(name) || { name, value: 0, holdings: [] };
      g.value += value;
      g.holdings.push({ index, value });
      map.set(name, g);
    };
    // Looking through, a linked copy is already split into its positions
    // (`copyPositionRows`), each with its own class (R15).
    holdings.forEach((h, index) => add(h.assetClass, index, h.currentValue));
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

const toNum = (v) => (v == null ? null : parseFloat(v.toString()));

/**
 * The rows a linked copy is shown as when looking through (#143): one per
 * position of the copy (`explodeCopyHoldings`), valued at its share of the
 * copy's eToro value and described like a directly held stock or ETF, plus
 * the copy's cash and its unidentified share. Each carries `viaCopies` (one
 * entry: the copy and how much of the row it holds) instead of item ids;
 * `foldCopyPositions()` then joins positions with the holdings of the same
 * symbol.
 */
function copyPositionRows(copyRow, positions) {
  return positions.map((p) => {
    const sm = p.security || {};
    const security = p.kind === 'SECURITY';
    const stockLike = security && !p.isEtf;
    // Stocks: their own sector/country ("Unknown" without data, like a direct
    // holding); ETFs: "Diversified", looked through by their composition;
    // crypto, other instruments, cash and unidentified: the "Other" remainder.
    const own = (v) => (security ? (p.isEtf ? DIVERSIFIED : (v || 'Unknown')) : LOOK_THROUGH_OTHER);
    const fallbackSymbol = p.kind === 'CASH' ? 'CASH' : 'OTHER';
    return {
      key: `copy:${copyRow.itemIds[0]}:${p.kind}:${p.nonEquity || ''}:${p.symbol || ''}:${p.exchange || ''}`,
      itemIds: [],
      viaCopies: [{
        username: copyRow.symbol,
        kind: p.kind,
        itemIds: copyRow.itemIds,
        currentValue: copyRow.currentValue * p.weight,
      }],
      symbol: p.symbol || fallbackSymbol,
      exchange: p.exchange,
      name: sm.name || p.symbol || fallbackSymbol,
      assetType: security ? (p.isEtf ? 'ETF' : 'STOCK') : 'OTHER',
      assetClass: p.assetClass,
      assetClassSource: 'AUTO',
      autoAssetClass: p.assetClass,
      composition: p.isEtf ? normalizeEtfComposition(sm.etfComposition) : null,
      quantity: null,
      currentValue: copyRow.currentValue * p.weight,
      currentValueUSD: copyRow.currentValueUSD * p.weight,
      sector: own(sm.sector),
      industry: own(sm.industry),
      country: own(sm.country),
      peRatio: stockLike && sm.earningsTrusted && sm.peRatio ? toNum(sm.peRatio) : null,
      dividendYield: security && sm.dividendTrusted && sm.dividendYield != null ? toNum(sm.dividendYield) : null,
      trailingEps: stockLike && sm.earningsTrusted && sm.trailingEps ? toNum(sm.trailingEps) : null,
      latestEpsActual: stockLike && sm.earningsTrusted && sm.latestEpsActual ? toNum(sm.latestEpsActual) : null,
      latestEpsSurprise: stockLike && sm.earningsTrusted && sm.latestEpsSurprise ? toNum(sm.latestEpsSurprise) : null,
      week52High: sm.week52High ? toNum(sm.week52High) : null,
      week52Low: sm.week52Low ? toNum(sm.week52Low) : null,
      averageVolume: sm.averageVolume ? toNum(sm.averageVolume) : null,
      logoUrl: sm.logoUrl || null,
      weight: 0,
    };
  });
}

// Security data a folded row takes from a copy position when it has none.
const FILL_FROM_POSITION = [
  'peRatio', 'dividendYield', 'trailingEps', 'latestEpsActual', 'latestEpsSurprise',
  'week52High', 'week52Low', 'averageVolume', 'logoUrl', 'composition',
];

/**
 * One row per security (#143), the way holdings of one symbol in several
 * accounts are already one row. A copy's position in a security is added to
 * the direct holding of that symbol when there is one (its item ids, asset
 * class override and dividend terms stay in charge), otherwise to the first
 * copy position of that symbol; `viaCopies` lists how much of the row each
 * copy holds. Cash, unidentified shares and non-equity instruments stay one
 * row per copy. Rows are copied, never mutated.
 */
function foldCopyPositions(rows) {
  const isSecurityPosition = (r) => r.itemIds.length === 0 && r.viaCopies?.[0]?.kind === 'SECURITY';
  const out = rows.map((r) => ({ ...r }));
  const bySymbol = new Map();
  for (const r of out) {
    if (r.assetType !== 'COPY_TRADE' && !r.viaCopies) bySymbol.set(r.symbol.toUpperCase(), r);
  }
  return out.filter((r) => {
    if (!isSecurityPosition(r)) return true;
    const symbol = r.symbol.toUpperCase();
    const target = bySymbol.get(symbol);
    if (!target) {
      r.key = `copy:${symbol}`;
      bySymbol.set(symbol, r);
      return true;
    }
    target.currentValue += r.currentValue;
    target.currentValueUSD += r.currentValueUSD;
    target.viaCopies = [...(target.viaCopies || []), ...r.viaCopies];
    for (const field of FILL_FROM_POSITION) {
      if (target[field] == null && r[field] != null) target[field] = r[field];
    }
    return false;
  });
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
    //    identifies them as ETFs. Copy Trading holdings (#143) come along and
    //    are handled separately.
    const candidateItems = await prisma.portfolioItem.findMany({
      where: {
        tenantId: req.user.tenantId,
        quantity: { gt: 0 },
        ...(accountId && { accountId: parseInt(accountId, 10) }),
        category: {
          processingHint: { in: [...EQUITY_HINTS, COPY_TRADING_HINT] },
        },
      },
      select: {
        id: true,
        symbol: true,
        // The live price lookup needs the listing: without it the backend asks
        // Twelve Data for the bare ticker, which can resolve to a different US
        // instrument (NVD on Xetra → a US-listed ETF, #159).
        exchange: true,
        accountId: true,
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

    const copyItems = candidateItems.filter((item) => item.category?.processingHint === COPY_TRADING_HINT);
    const securityItems = candidateItems.filter((item) => item.category?.processingHint !== COPY_TRADING_HINT);

    // 2. Fetch SecurityMaster data for all stock/fund symbols
    const candidateSymbols = [...new Set(securityItems.map((item) => item.symbol))];
    const securityMasterRecords = candidateSymbols.length
      ? await prisma.securityMaster.findMany({ where: { symbol: { in: candidateSymbols } } })
      : [];
    const smMap = Object.fromEntries(securityMasterRecords.map((r) => [r.symbol, r]));

    // API_FUND items are kept in the equity views only when SecurityMaster
    // identifies them as ETFs.
    const stockItems = securityItems.filter(
      (item) => item.category?.processingHint === 'API_STOCK' || isEtf(smMap[item.symbol]),
    );

    // #93 B5: an API_FUND with a ticker but no SecurityMaster asset type yet
    // (bought before refresh-tenant-securities ran, or no Twelve Data key)
    // can't be told apart from a mutual fund, so it is left out above. Report
    // it so the page and agents can explain the gap. Ticker-less MANUAL funds
    // never get SecurityMaster data and aren't pending.
    const pendingSecurityData = [...new Set(
      securityItems
        .filter((item) => item.category?.processingHint === 'API_FUND'
          && item.source !== 'MANUAL'
          && !smMap[item.symbol]?.assetType)
        .map((item) => item.symbol),
    )];

    // 3. Enrich holdings with live prices and SecurityMaster data
    // One FX lookup per currency pair per request, shared by every holding
    // (unbounded per-holding lookups exhausted the DB pool — #135).
    const convertCurrency = createCurrencyConverter();

    const enrichedHoldings = await Promise.all(
      stockItems.map(async (item) => {
        const quantity = new Decimal(item.quantity || 0);
        let marketValueUSD = new Decimal(item.currentValueInUSD || 0);

        // Fetch live price for non-manual items
        if (item.source !== 'MANUAL' && quantity.gt(0)) {
          try {
            const livePricePerUnit = await calculateAssetCurrentValue(item);
            // null = no live price (timeout, 404, 5xx): keep the stored value.
            if (livePricePerUnit && livePricePerUnit.gt(0)) {
              const priceCurrency = item.assetCurrency || item.currency;
              const marketValueInPriceCurrency = livePricePerUnit.times(quantity);

              if (priceCurrency === 'USD') {
                marketValueUSD = marketValueInPriceCurrency;
              } else {
                const converted = await convertCurrency(marketValueInPriceCurrency, priceCurrency, 'USD');
                marketValueUSD = converted || marketValueInPriceCurrency;
              }
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

    // 3a. Copy Trading holdings (#143): valued by the eToro sync (stored
    //     value, no live price), split by the user's own copy holdings.
    const copyLookThrough = copyItems.length > 0
      ? await loadCopyLookThrough(req.user.tenantId, copyItems)
      : new Map();
    const copyHoldings = await Promise.all(copyItems.map(async (item) => {
      const { copy, composition } = copyLookThrough.get(item.id) || {};
      const valueUSD = parseFloat(new Decimal(item.currentValueInUSD || 0).toString());
      let currentValue = valueUSD;
      if (portfolioCurrency !== 'USD') {
        const converted = await convertCurrency(new Decimal(valueUSD), 'USD', portfolioCurrency);
        if (converted) currentValue = parseFloat(converted.toString());
      }
      const classInput = classifierInput(item, null);
      const { assetClass, source: assetClassSource } = classifyAssetClass(classInput);
      const autoAssetClass = classifyAssetClass({ ...classInput, override: null }).assetClass;
      const dividendYield = composition?.dividendYield ?? null;
      return {
        id: item.id,
        // Never merged with another holding: every copy has its own holdings.
        mergeKey: `copy:${item.id}`,
        symbol: item.symbol,
        name: `@${item.symbol}`,
        assetType: 'COPY_TRADE',
        assetClass,
        assetClassSource,
        autoAssetClass,
        composition: composition ? { sectors: composition.sectors, countries: composition.countries } : null,
        assetClassMix: composition?.assetClassMix || null,
        quantity: parseFloat(new Decimal(item.quantity || 0).toString()),
        currentValue,
        currentValueUSD: valueUSD,
        sector: DIVERSIFIED,
        industry: DIVERSIFIED,
        country: DIVERSIFIED,
        // Value-weighted over the copy's holdings with data (R17).
        peRatio: composition?.peRatio ?? null,
        dividendYield,
        peCoverage: composition?.peCoverage ?? null,
        yieldCoverage: composition?.yieldCoverage ?? null,
        sectorCoveragePct: composition?.sectorCoveragePct ?? null,
        countryCoveragePct: composition?.countryCoveragePct ?? null,
        unmappedPct: composition?.unmappedPct ?? null,
        copyTrade: copyTradeStatus(copy),
        trailingEps: null,
        latestEpsActual: null,
        latestEpsSurprise: null,
        week52High: null,
        week52Low: null,
        averageVolume: null,
        logoUrl: null,
        annualDividendUSD: dividendYield != null ? dividendYield * valueUSD : null,
        weight: 0,
      };
    }));
    enrichedHoldings.push(...copyHoldings);

    // 3b. Merge entries for the same symbol held across multiple accounts.
    //     SecurityMaster data (sector, P/E, etc.) is per-symbol so it is
    //     identical across accounts — we just sum the financial values. The
    //     asset class override is set per symbol, so an OVERRIDE wins the merge.
    const symbolMap = new Map();
    for (const { id, mergeKey, ...h } of enrichedHoldings) {
      const key = mergeKey || h.symbol;
      if (symbolMap.has(key)) {
        const existing = symbolMap.get(key);
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
        symbolMap.set(key, { ...h, itemIds: [id] });
      }
    }
    const mergedHoldings = [...symbolMap.values()].map(({ annualDividendUSD, ...h }) => ({
      ...h,
      dividendYield: h.dividendYield != null ? Math.round(h.dividendYield * 1e6) / 1e6 : null,
    }));

    // 3c. Looking through, a linked copy is replaced by its own positions
    //     (#143), so the groups, the Top 10 and the table show the equities
    //     the money is in, one row per security with what each copy holds of
    //     it. A copy with nothing but unidentified holdings stays one row. The
    //     copies themselves are returned in `copies`.
    const copies = mergedHoldings.filter((h) => h.assetType === 'COPY_TRADE');
    const rows = lookThroughEnabled
      ? foldCopyPositions(mergedHoldings.flatMap((h) => {
        if (h.assetType !== 'COPY_TRADE') return [h];
        const positions = copyLookThrough.get(h.itemIds[0])?.positions || [];
        return positions.some((p) => p.kind !== 'UNMAPPED') ? copyPositionRows(h, positions) : [h];
      }))
      : mergedHoldings;

    // 4. Compute total equity value and weights
    const totalEquityValue = mergedHoldings.reduce((sum, h) => sum + h.currentValue, 0);

    for (const h of [...rows, ...copies]) {
      h.weight = totalEquityValue > 0 ? h.currentValue / totalEquityValue : 0;
    }

    // 5. Compute weighted P/E and dividend yield (unchanged by look-through).
    //    A copy counts only with the share of its value its P/E / yield is
    //    based on (#143).
    let weightedPeRatio = null;
    let weightedDividendYield = null;
    const covered = (h, coverage) => h.weight * (coverage == null ? 1 : coverage / 100);

    const holdingsWithPe = rows.filter((h) => h.peRatio != null && h.peRatio > 0);
    if (holdingsWithPe.length > 0) {
      const peWeightSum = holdingsWithPe.reduce((sum, h) => sum + covered(h, h.peCoverage), 0);
      if (peWeightSum > 0) {
        weightedPeRatio = holdingsWithPe.reduce((sum, h) => sum + h.peRatio * (covered(h, h.peCoverage) / peWeightSum), 0);
        weightedPeRatio = Math.round(weightedPeRatio * 100) / 100;
      }
    }

    const holdingsWithYield = rows.filter((h) => h.dividendYield != null && h.dividendYield > 0);
    if (holdingsWithYield.length > 0) {
      const yieldWeightSum = holdingsWithYield.reduce((sum, h) => sum + covered(h, h.yieldCoverage), 0);
      if (yieldWeightSum > 0) {
        weightedDividendYield = holdingsWithYield.reduce((sum, h) => sum + h.dividendYield * (covered(h, h.yieldCoverage) / yieldWeightSum), 0);
        weightedDividendYield = Math.round(weightedDividendYield * 1000000) / 1000000;
      }
    }

    // 6. Group by every dimension. Sector and country look through ETFs
    //    (unless lookThrough=false); an ETF can then sit in several groups, so
    //    the flat `holdings` list is the one to render rows from.
    const groupings = Object.fromEntries(
      GROUPINGS.map((dim) => [dim, groupHoldings(rows, dim, totalEquityValue, lookThroughEnabled)]),
    );
    const holdings = [...rows].sort((a, b) => b.currentValue - a.currentValue);

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
        holdingsCount: holdings.length,
        copyTradeCount: copies.length,
        weightedPeRatio,
        weightedDividendYield,
        pendingSecurityDataCount: pendingSecurityData.length,
      },
      // Fund symbols left out until their SecurityMaster data arrives.
      pendingSecurityData,
      groups: groupings[groupBy],
      groupings,
      holdings,
      // eToro copies (#143), also when they are split into `holdings` rows:
      // link status, coverage and the unidentified share live here.
      copies,
    });
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});
