/**
 * Asset class classifier and portfolio aggregations (Equity Analysis #79).
 *
 * One definition shared by the API (Equity Analysis) and the backend (AI
 * insights, #80) so both always agree on what a holding is. Pure: no Prisma,
 * no I/O — every input is a plain object.
 *
 * Conventions:
 *   - ETF composition weights are FRACTIONS (0.5915 = 59.15%). Twelve Data
 *     sometimes returns percentages; `normalizeEtfComposition` fixes that.
 *   - Output percentages (`percent`, `governmentPct`, …) are 0–100, rounded to
 *     2 decimals. Rates stored on IncomeTerms are percentages (5.25 = 5.25%).
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const ASSET_CLASSES = [
  'STOCK',
  'INDEX_ETF',
  'SECTOR_ETF',
  'BOND_ETF',
  'REIT',
  'FUND',
  'GOV_BOND',
  'CORP_BOND',
  'REAL_ESTATE',
  'CRYPTO',
  'CASH',
  'OTHER',
];

/** Classes shown in the equity sector / industry / country views. */
export const EQUITY_ASSET_CLASSES = ['STOCK', 'REIT', 'INDEX_ETF', 'SECTOR_ETF'];

/** An ETF whose largest sector is at least this share is a SECTOR_ETF (QQQ at 59% stays INDEX_ETF). */
export const SECTOR_ETF_THRESHOLD = 0.75;

/** An ETF whose asset allocation is at least this share bonds is a BOND_ETF. */
export const BOND_ETF_THRESHOLD = 0.5;

/** Name fallback for bond ETFs without composition data. */
export const BOND_ETF_NAME_PATTERN = /bond|treasury|fixed income|aggregate|gilt/i;

export function isValidAssetClass(value) {
  return typeof value === 'string' && ASSET_CLASSES.includes(value);
}

function isType(value, expected) {
  return typeof value === 'string' && value.trim().toUpperCase() === expected;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ─── ETF composition ─────────────────────────────────────────────────────────

/**
 * Normalize a stored/fetched ETF composition. Weights become fractions (any
 * list whose weights sum above 1.5 is treated as percentages), entries with no
 * name or a non-positive weight are dropped, and a list that still sums above
 * 1 is scaled down to 1 so look-through never inflates a holding.
 *
 * @param {Object|null} raw { sectors: [{sector, weight}], countries: [{country, weight}], assetAllocation: {...} }
 * @returns {{ sectors: Array<{sector: string, weight: number}>, countries: Array<{country: string, weight: number}>, assetAllocation: Object }|null}
 */
export function normalizeEtfComposition(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const normList = (list, key) => {
    if (!Array.isArray(list)) return [];
    const entries = list
      .map((e) => ({ [key]: typeof e?.[key] === 'string' ? e[key].trim() : '', weight: toNumber(e?.weight) }))
      .filter((e) => e[key] && e.weight != null && e.weight > 0);
    let sum = entries.reduce((s, e) => s + e.weight, 0);
    if (sum > 1.5) {
      for (const e of entries) e.weight /= 100;
      sum /= 100;
    }
    if (sum > 1) {
      for (const e of entries) e.weight /= sum;
    }
    return entries.sort((a, b) => b.weight - a.weight);
  };

  const allocation = {};
  if (raw.assetAllocation && typeof raw.assetAllocation === 'object') {
    const values = Object.entries(raw.assetAllocation)
      .map(([k, v]) => [k, toNumber(v)])
      .filter(([, v]) => v != null);
    const isPercent = values.reduce((s, [, v]) => s + Math.max(v, 0), 0) > 1.5;
    for (const [k, v] of values) allocation[k] = isPercent ? v / 100 : v;
  }

  return {
    sectors: normList(raw.sectors, 'sector'),
    countries: normList(raw.countries, 'country'),
    assetAllocation: allocation,
  };
}

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify one portfolio item. The first matching rule wins:
 *   1. a valid user override
 *   2. bond issuer type from income terms, then the government / corporate
 *      bond default category codes
 *   3. real estate, crypto and cash categories
 *   4. SecurityMaster assetType REIT (US REITs and Brazilian FIIs)
 *   5. SecurityMaster assetType ETF → BOND_ETF / SECTOR_ETF / INDEX_ETF
 *   6. stock categories (API_STOCK) → STOCK
 *   7. fund categories (API_FUND) → FUND
 *   8. OTHER
 *
 * The profile's sector/industry are never used for ETFs (unreliable, #77 spike).
 *
 * @param {Object} i
 * @param {string|null} [i.override]             PortfolioItem.assetClassOverride
 * @param {string|null} [i.processingHint]       Category.processingHint
 * @param {string|null} [i.defaultCategoryCode]  Category.defaultCategoryCode
 * @param {string|null} [i.categoryGroup]        Category.group
 * @param {Object|null} [i.security]             { assetType, name, composition }
 * @param {Object|null} [i.incomeTerms]          { issuerType, incomeType }
 * @returns {{ assetClass: string, source: 'OVERRIDE'|'AUTO' }}
 */
export function classifyAssetClass(i = {}) {
  if (isValidAssetClass(i.override)) return { assetClass: i.override, source: 'OVERRIDE' };
  return { assetClass: autoAssetClass(i), source: 'AUTO' };
}

function autoAssetClass({ processingHint, defaultCategoryCode, categoryGroup, security, incomeTerms } = {}) {
  const code = defaultCategoryCode || null;

  // 2. Bonds
  if (incomeTerms?.issuerType === 'GOVERNMENT') return 'GOV_BOND';
  if (incomeTerms?.issuerType === 'CORPORATE') return 'CORP_BOND';
  if (code === 'GOVERNMENT_BONDS') return 'GOV_BOND';
  if (code === 'CORPORATE_BONDS') return 'CORP_BOND';

  // 3. Category-driven classes
  if (code === 'REAL_ESTATE' || categoryGroup === 'Real Estate') return 'REAL_ESTATE';
  if (processingHint === 'API_CRYPTO') return 'CRYPTO';
  if (processingHint === 'CASH') return 'CASH';
  // Commodities use the API_STOCK hint for pricing but aren't stocks.
  if (code === 'COMMODITIES') return 'OTHER';

  // 4. REITs (O, HGLG11)
  if (isType(security?.assetType, 'REIT')) return 'REIT';

  // 5. ETFs
  if (isType(security?.assetType, 'ETF')) {
    const composition = normalizeEtfComposition(security.composition);
    const bonds = toNumber(composition?.assetAllocation?.bonds);
    const hasComposition = !!composition &&
      (composition.sectors.length > 0 || Object.keys(composition.assetAllocation).length > 0);
    if (hasComposition) {
      if (bonds != null && bonds >= BOND_ETF_THRESHOLD) return 'BOND_ETF';
    } else if (typeof security.name === 'string' && BOND_ETF_NAME_PATTERN.test(security.name)) {
      return 'BOND_ETF';
    }
    const largest = composition?.sectors?.[0]?.weight ?? 0;
    if (largest >= SECTOR_ETF_THRESHOLD) return 'SECTOR_ETF';
    return 'INDEX_ETF';
  }

  // 6–8
  if (processingHint === 'API_STOCK') return 'STOCK';
  if (processingHint === 'API_FUND') return 'FUND';
  return 'OTHER';
}

// ─── Aggregations ────────────────────────────────────────────────────────────

/**
 * Portfolio composition by asset class.
 *
 * @param {Array<{assetClass: string, value: number}>} items  values already in the display currency
 * @returns {Array<{assetClass: string, value: number, percent: number, count: number}>} largest first
 */
export function buildComposition(items = []) {
  const byClass = new Map();
  let total = 0;
  for (const item of items) {
    const value = toNumber(item?.value) ?? 0;
    if (value <= 0 || !isValidAssetClass(item.assetClass)) continue;
    const row = byClass.get(item.assetClass) || { assetClass: item.assetClass, value: 0, count: 0 };
    row.value += value;
    row.count += 1;
    byClass.set(item.assetClass, row);
    total += value;
  }
  return [...byClass.values()]
    .map((r) => ({ ...r, value: round2(r.value), percent: total > 0 ? round2((r.value / total) * 100) : 0 }))
    .sort((a, b) => b.value - a.value || ASSET_CLASSES.indexOf(a.assetClass) - ASSET_CLASSES.indexOf(b.assetClass));
}

/** Current coupon / assumed rate (%) of a bond's income terms; null when unknown. */
export function bondCouponPct(terms) {
  if (!terms) return null;
  const coupon = toNumber(terms.couponRate);
  const index = toNumber(terms.assumedIndexRate);
  const spread = toNumber(terms.spread);
  switch (terms.incomeType) {
    case 'FIXED_COUPON':
      return coupon;
    case 'FLOATING_COUPON':
      return index == null && spread == null ? null : (index ?? 0) + (spread ?? 0);
    case 'INFLATION_LINKED':
      return coupon == null && index == null ? null : (coupon ?? 0) + (index ?? 0);
    default:
      return coupon;
  }
}

/**
 * Fixed income summary over direct bonds with income terms.
 *
 * @param {Array<{assetClass: 'GOV_BOND'|'CORP_BOND', face: number, couponPct: number|null, maturityDate: string|Date|null}>} bonds
 *   `face` = faceValuePerUnit × quantity, already in the display currency
 * @param {Object} [opts]
 * @param {string|Date} [opts.asOf]  defaults to now
 * @returns {{ totalFace: number, weightedCouponPct: number|null, avgYearsToMaturity: number|null,
 *             governmentPct: number, corporatePct: number, count: number }|null} null without bonds
 */
export function buildFixedIncome(bonds = [], { asOf = new Date() } = {}) {
  const asOfMs = new Date(asOf).getTime();
  const rows = bonds.filter(
    (b) => (b?.assetClass === 'GOV_BOND' || b?.assetClass === 'CORP_BOND') && (toNumber(b.face) ?? 0) > 0,
  );
  if (rows.length === 0) return null;

  let totalFace = 0;
  let govFace = 0;
  let couponFace = 0;
  let couponSum = 0;
  let maturityFace = 0;
  let maturitySum = 0;
  for (const b of rows) {
    const face = toNumber(b.face);
    totalFace += face;
    if (b.assetClass === 'GOV_BOND') govFace += face;
    const coupon = toNumber(b.couponPct);
    if (coupon != null) {
      couponFace += face;
      couponSum += coupon * face;
    }
    const maturityMs = b.maturityDate ? new Date(b.maturityDate).getTime() : NaN;
    if (Number.isFinite(maturityMs)) {
      const years = Math.max(0, (maturityMs - asOfMs) / (365.25 * 24 * 60 * 60 * 1000));
      maturityFace += face;
      maturitySum += years * face;
    }
  }

  const governmentPct = round2((govFace / totalFace) * 100);
  return {
    totalFace: round2(totalFace),
    weightedCouponPct: couponFace > 0 ? round2(couponSum / couponFace) : null,
    avgYearsToMaturity: maturityFace > 0 ? round2(maturitySum / maturityFace) : null,
    governmentPct,
    corporatePct: round2(100 - governmentPct),
    count: rows.length,
  };
}
