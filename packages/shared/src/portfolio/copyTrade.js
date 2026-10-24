/**
 * eToro copy-trade look-through (#143).
 *
 * A linked copy is treated like an ETF whose composition is the user's own
 * copy holdings. The sync stores those holdings as mapped listings
 * (`{symbol, exchange, valuePct}` + `cashPct`); this module turns them into an
 * ETF-shaped composition on read, from SecurityMaster, so new fundamentals
 * show up without another eToro sync ("computed on read, no stored
 * aggregates").
 *
 * Shared by the API (Equity Analysis) and the backend (#80 insight lenses).
 * Pure: no Prisma, no I/O.
 *
 * Conventions follow assetClass.js: holding `valuePct` and the `*Pct` outputs
 * are 0–100; composition weights are FRACTIONS of the copy's value.
 */

import { classifyAssetClass, normalizeEtfComposition } from './assetClass.js';
import { FIXED_INCOME_BUCKET } from './lookThrough.js';

/** MICs a US variant (eToro Regular Trading Hours, Texas) folds into. */
const US_MICS = ['XNAS', 'XNYS', 'BATS'];

/** Asset class of each non-equity eToro instrument kind (see @bliss/shared/etoro). */
const NON_EQUITY_CLASS = { CRYPTO: 'CRYPTO', CURRENCY: 'OTHER', COMMODITY: 'OTHER', INDEX: 'OTHER', FUTURE: 'OTHER' };

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function isType(value, expected) {
  return typeof value === 'string' && value.trim().toUpperCase() === expected;
}

/**
 * Merge holdings that are the same listing. eToro can hold one company twice
 * (`AMZN` on Nasdaq and the `AMZN.RTH` variant); both become one line.
 * A US variant (`usVariant`, no MIC) folds into the US listing with the same
 * symbol, or stays on its own when the copy has none. Non-equity holdings
 * (`nonEquity`: crypto, commodities, currencies, index CFDs, futures) merge by
 * kind + symbol. Unresolved holdings (no symbol) are summed into `unmappedPct`.
 *
 * @param {Array<{symbol?: string, exchange?: string|null, valuePct: number, type?: string|null,
 *                usVariant?: boolean, nonEquity?: string|null, unresolved?: boolean,
 *                instrumentId?: number|string}>} holdings
 * @returns {{ holdings: Array<{symbol: string, exchange: string|null, type: string|null,
 *             nonEquity: string|null, valuePct: number, instrumentIds: Array}>, unmappedPct: number }} largest first
 */
export function mergeCopyHoldings(holdings = []) {
  const byKey = new Map();
  const usVariants = [];
  let unmappedPct = 0;

  for (const h of Array.isArray(holdings) ? holdings : []) {
    const valuePct = toNumber(h?.valuePct);
    if (!(valuePct > 0)) continue;
    const symbol = typeof h.symbol === 'string' ? h.symbol.trim().toUpperCase() : '';
    if (h.unresolved || !symbol) {
      unmappedPct += valuePct;
      continue;
    }
    if (h.nonEquity) {
      addTo(byKey, `${h.nonEquity}:${symbol}`, { ...h, symbol, valuePct, exchange: null });
      continue;
    }
    if (h.usVariant && !h.exchange) {
      usVariants.push({ ...h, symbol, valuePct });
      continue;
    }
    addTo(byKey, `${symbol}|${h.exchange || ''}`, { ...h, symbol, valuePct });
  }

  for (const h of usVariants) {
    const sibling = US_MICS.map((mic) => `${h.symbol}|${mic}`).find((key) => byKey.has(key));
    addTo(byKey, sibling || `${h.symbol}|`, h);
  }

  return {
    holdings: [...byKey.values()].sort((a, b) => b.valuePct - a.valuePct),
    unmappedPct,
  };
}

function addTo(map, key, h) {
  const existing = map.get(key);
  const id = h.instrumentId ?? null;
  if (existing) {
    existing.valuePct += h.valuePct;
    if (id != null) existing.instrumentIds.push(id);
    if (!existing.type && h.type) existing.type = h.type;
    return;
  }
  map.set(key, {
    symbol: h.symbol,
    exchange: h.exchange || null,
    type: h.type || null,
    nonEquity: h.nonEquity || null,
    valuePct: h.valuePct,
    instrumentIds: id != null ? [id] : [],
  });
}

function lookupSecurity(securities, symbol) {
  if (!securities) return null;
  if (securities instanceof Map) return securities.get(symbol) || null;
  return securities[symbol] || null;
}

function classifyHolding(h, sm) {
  if (h.nonEquity) return NON_EQUITY_CLASS[h.nonEquity] || 'OTHER';
  const etf = h.type === 'ETF' || isType(sm?.assetType, 'ETF');
  return classifyAssetClass({
    processingHint: etf ? 'API_FUND' : 'API_STOCK',
    defaultCategoryCode: etf ? 'ETFS' : null,
    security: sm ? { assetType: sm.assetType, name: sm.name, composition: sm.etfComposition } : null,
  }).assetClass;
}

const toList = (map, key) =>
  [...map.entries()]
    .map(([name, weight]) => ({ [key]: name, weight: round6(weight) }))
    .filter((e) => e.weight > 0)
    .sort((a, b) => b.weight - a.weight);

/**
 * Derive a copy's look-through composition, P/E and dividend yield.
 *
 * Per holding, by its asset class (the #79 classifier, with eToro's
 * instrument type standing in for the category):
 *   - STOCK / REIT: its own SecurityMaster sector and country.
 *   - INDEX_ETF / SECTOR_ETF with `etfComposition`: spread across its
 *     sectors and countries by weight (two-level look-through).
 *   - BOND_ETF: "Fixed Income" in both views, like a directly held bond ETF.
 *   - ETFs without composition, funds, other and unknown data: left out, so
 *     `lookThrough()` puts them in the copy's "Other" remainder.
 *   - Non-equity instruments: `CRYPTO` (crypto) or `OTHER` (currencies,
 *     commodities, index CFDs, futures) in `assetClassMix`; never enriched.
 *   - Copy cash: `CASH` in `assetClassMix` only.
 *   - Unresolved instruments: `OTHER` in `assetClassMix`, counted in `unmappedPct`.
 *
 * P/E is stock-only and needs `earningsTrusted`; dividend yield needs
 * `dividendTrusted`. Both are value-weighted over the holdings with data,
 * and `peCoverage` / `yieldCoverage` say how much of the copy that is.
 *
 * @param {{ holdings: Array, cashPct?: number|null }} copy  the stored EtoroCopy holdings
 * @param {Map<string, Object>|Object<string, Object>} securities
 *   SecurityMaster rows by symbol: { assetType, name, sector, country, peRatio, dividendYield,
 *   earningsTrusted, dividendTrusted, etfComposition }
 * @returns {{ sectors: Array<{sector: string, weight: number}>, countries: Array<{country: string, weight: number}>,
 *             assetClassMix: Array<{assetClass: string, weight: number}>, peRatio: number|null,
 *             dividendYield: number|null, peCoverage: number, yieldCoverage: number,
 *             sectorCoveragePct: number, countryCoveragePct: number, unmappedPct: number }}
 */
export function deriveCopyComposition(copy = {}, securities = null) {
  const merged = mergeCopyHoldings(copy?.holdings);
  const cashPct = Math.max(toNumber(copy?.cashPct) ?? 0, 0);

  // eToro values can drift a little past 100%; never let a copy inflate.
  const total = merged.holdings.reduce((s, h) => s + h.valuePct, 0) + merged.unmappedPct + cashPct;
  const scale = total > 100 ? 100 / total : 1;

  const sectors = new Map();
  const countries = new Map();
  const classes = new Map();
  const add = (map, name, w) => {
    if (!name || !(w > 0)) return;
    map.set(name, (map.get(name) || 0) + w);
  };

  let sectorCovered = 0;
  let countryCovered = 0;
  let peWeight = 0;
  let peSum = 0;
  let yieldWeight = 0;
  let yieldSum = 0;

  for (const h of merged.holdings) {
    const w = (h.valuePct * scale) / 100;
    const sm = h.nonEquity ? null : lookupSecurity(securities, h.symbol);
    const cls = classifyHolding(h, sm);
    add(classes, cls, w);

    if (cls === 'STOCK' || cls === 'REIT') {
      const sector = typeof sm?.sector === 'string' ? sm.sector.trim() : '';
      const country = typeof sm?.country === 'string' ? sm.country.trim() : '';
      if (sector) { add(sectors, sector, w); sectorCovered += w; }
      if (country) { add(countries, country, w); countryCovered += w; }
    } else if (cls === 'BOND_ETF') {
      add(sectors, FIXED_INCOME_BUCKET, w);
      add(countries, FIXED_INCOME_BUCKET, w);
      sectorCovered += w;
      countryCovered += w;
    } else if (cls === 'INDEX_ETF' || cls === 'SECTOR_ETF') {
      const composition = normalizeEtfComposition(sm?.etfComposition);
      for (const e of composition?.sectors || []) { add(sectors, e.sector, w * e.weight); sectorCovered += w * e.weight; }
      for (const e of composition?.countries || []) { add(countries, e.country, w * e.weight); countryCovered += w * e.weight; }
    }

    const pe = toNumber(sm?.peRatio);
    if (cls === 'STOCK' && sm?.earningsTrusted && pe != null && pe > 0) {
      peWeight += w;
      peSum += pe * w;
    }
    const dividendYield = toNumber(sm?.dividendYield);
    if (sm?.dividendTrusted && dividendYield != null && dividendYield >= 0) {
      yieldWeight += w;
      yieldSum += dividendYield * w;
    }
  }

  add(classes, 'CASH', (cashPct * scale) / 100);
  add(classes, 'OTHER', (merged.unmappedPct * scale) / 100);

  return {
    sectors: toList(sectors, 'sector'),
    countries: toList(countries, 'country'),
    assetClassMix: toList(classes, 'assetClass'),
    peRatio: peWeight > 0 ? round2(peSum / peWeight) : null,
    dividendYield: yieldWeight > 0 ? round6(yieldSum / yieldWeight) : null,
    peCoverage: round2(peWeight * 100),
    yieldCoverage: round2(yieldWeight * 100),
    sectorCoveragePct: round2(sectorCovered * 100),
    countryCoveragePct: round2(countryCovered * 100),
    unmappedPct: round2(merged.unmappedPct * scale),
  };
}
