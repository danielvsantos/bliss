/**
 * @bliss/shared/portfolio — pure portfolio math shared by the API and backend.
 *
 * Passive income projection (#77). `project()` turns income terms, SecurityMaster
 * dividend history and income streams into a dated cash-flow schedule for up to
 * 36 months, then groups it by month, year and item.
 *
 * No Prisma and no I/O in here: every input is a plain object. Monetary inputs
 * are in each item's own currency and carry an `fxRate` (native → display
 * currency multiplier) resolved by the caller, so every output amount is in
 * the display currency.
 *
 * Conventions:
 *   - Dates are handled as UTC calendar days ('YYYY-MM-DD').
 *   - Rates stored on IncomeTerms (couponRate, spread, assumedIndexRate,
 *     yieldPct, apyPct, annualIndexationPct) are PERCENTAGES (5.25 = 5.25%).
 *   - Yields in the output (rateOrYield, yieldOnValue) are FRACTIONS (0.0525),
 *     matching the Equity Analysis `dividendYield` convention.
 *   - The projection covers the next `horizon` FULL calendar months, starting on
 *     the 1st of the month after `asOf` (the current month belongs to actuals).
 *     Upcoming payments and "next payment date" also include the rest of the
 *     current month.
 */

// Asset classes & ETF look-through (Equity Analysis #79).
export * from './assetClass.js';
export * from './lookThrough.js';
// Insights summary of a projection (#80).
export * from './summarize.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Projected payment date for an automatic dividend = ex-date + this many days. */
export const PAYMENT_LAG_DAYS = 14;

export const HORIZONS = [12, 24, 36];

export const INCOME_TYPES = [
  'DIVIDEND',
  'FIXED_COUPON',
  'FLOATING_COUPON',
  'INFLATION_LINKED',
  'RENT',
  'INTEREST',
  'CUSTOM_YIELD',
  'FIXED_AMOUNT',
  'NONE',
];

export const INCOME_FREQUENCIES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'AT_MATURITY'];

export const REFERENCE_INDICES = ['SOFR', 'EURIBOR', 'CDI', 'SELIC', 'IPCA', 'CPI', 'OTHER'];

export const BOND_ISSUER_TYPES = ['GOVERNMENT', 'CORPORATE'];

/** Output buckets, in chart stacking order. `other` = allowance & benefits (streams). */
export const INCOME_BUCKETS = ['dividend', 'coupon', 'rent', 'interest', 'other'];

/** Required fields per income type (validated by the API and the web zod schema). */
export const REQUIRED_FIELDS_BY_TYPE = {
  DIVIDEND: [],
  FIXED_COUPON: ['faceValuePerUnit', 'couponRate', 'frequency', 'maturityDate'],
  FLOATING_COUPON: ['faceValuePerUnit', 'assumedIndexRate', 'frequency', 'maturityDate'],
  INFLATION_LINKED: ['faceValuePerUnit', 'couponRate', 'assumedIndexRate', 'frequency', 'maturityDate'],
  RENT: ['monthlyRent'],
  INTEREST: ['apyPct'],
  CUSTOM_YIELD: ['yieldPct'],
  FIXED_AMOUNT: ['name', 'amountPerPayment', 'frequency', 'currency', 'startDate'],
  NONE: [],
};

/** Default Passive Income categories that are produced by assets, so they can't hold streams. */
export const ASSET_INCOME_CATEGORY_CODES = [
  'DIVIDENDS',
  'BOND_INCOME',
  'INTEREST_INCOME',
  'RENT_INCOME',
  'OPTIONS_INCOME',
];

export const PASSIVE_INCOME_GROUP = 'Passive Income';

/** A floating / inflation-linked assumed index rate older than this is flagged STALE_RATE. */
export const STALE_RATE_DAYS = 180;

const PAYMENTS_PER_YEAR = {
  WEEKLY: 52,
  MONTHLY: 12,
  QUARTERLY: 4,
  SEMIANNUAL: 2,
  ANNUAL: 1,
};

const MONTH_STEP = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Asset classification ────────────────────────────────────────────────────

/**
 * Asset classes that can produce passive income. `null` means not income-capable
 * (crypto, collectibles, vehicles, commodities, debt, non-portfolio categories).
 *
 * @param {Object} p
 * @param {string|null} [p.type]                 Category.type
 * @param {string|null} [p.group]                Category.group
 * @param {string|null} [p.processingHint]       Category.processingHint
 * @param {string|null} [p.defaultCategoryCode]  Category.defaultCategoryCode
 * @param {string|null} [p.securityAssetType]    SecurityMaster.assetType ("ETF", "Common Stock", …)
 * @returns {'STOCK'|'ETF'|'FUND'|'BOND'|'REAL_ESTATE'|'CASH'|'OTHER'|null}
 */
export function classifyIncomeAsset({ type, group, processingHint, defaultCategoryCode, securityAssetType } = {}) {
  const code = defaultCategoryCode || null;
  if (processingHint === 'CASH') return 'CASH';
  if (type !== 'Investments' && type !== 'Asset') return null;
  if (processingHint === 'API_CRYPTO') return null;
  if (code === 'COMMODITIES' || group === 'Commodities') return null;
  if (code === 'COLLECTIBLE' || code === 'VEHICLE' || group === 'Collectible' || group === 'Depreciating assets') {
    return null;
  }
  if (code === 'GOVERNMENT_BONDS' || code === 'CORPORATE_BONDS' || group === 'Bonds') return 'BOND';
  if (code === 'REAL_ESTATE' || group === 'Real Estate') return 'REAL_ESTATE';
  if (securityAssetType === 'ETF') return 'ETF';
  if (processingHint === 'API_STOCK') return 'STOCK';
  if (processingHint === 'API_FUND') return code === 'ETFS' || group === 'ETFs' ? 'ETF' : 'FUND';
  return 'OTHER';
}

/** Asset classes that count toward "N of M configured" and can be flagged missing. */
export const COVERAGE_ASSET_CLASSES = ['STOCK', 'ETF', 'FUND', 'BOND', 'REAL_ESTATE'];

/** Income type pre-selected in the Income Terms modal for each asset class. */
export const DEFAULT_INCOME_TYPE_BY_CLASS = {
  STOCK: 'DIVIDEND',
  ETF: 'DIVIDEND',
  FUND: 'DIVIDEND',
  BOND: 'FIXED_COUPON',
  REAL_ESTATE: 'RENT',
  CASH: 'INTEREST',
  OTHER: 'CUSTOM_YIELD',
};

/**
 * Is `category` eligible to hold income streams? Income type, "Passive Income"
 * group, not produced by an asset (no processingHint, IGNORE key strategy, not
 * one of the asset-produced default categories).
 */
export function isStreamEligibleCategory(category) {
  if (!category) return false;
  return (
    category.type === 'Income' &&
    category.group === PASSIVE_INCOME_GROUP &&
    !category.processingHint &&
    (category.portfolioItemKeyStrategy == null || category.portfolioItemKeyStrategy === 'IGNORE') &&
    !ASSET_INCOME_CATEGORY_CODES.includes(category.defaultCategoryCode)
  );
}

// ─── Validation ──────────────────────────────────────────────────────────────

function isBlank(v) {
  return v === undefined || v === null || v === '';
}

/**
 * Validate an income terms payload. Returns a list of `{ field, message }`;
 * empty means valid. Shared by the API routes (server-side) and mirrored by
 * the web zod schema.
 *
 * @param {Object} terms
 * @param {{ mode?: 'asset'|'stream' }} [opts]
 */
export function validateIncomeTerms(terms, { mode = 'asset' } = {}) {
  const errors = [];
  if (!terms || typeof terms !== 'object') return [{ field: 'incomeType', message: 'Body is required' }];
  const { incomeType } = terms;
  if (!INCOME_TYPES.includes(incomeType)) {
    return [{ field: 'incomeType', message: `incomeType must be one of: ${INCOME_TYPES.join(', ')}` }];
  }
  if (mode === 'stream' && incomeType !== 'FIXED_AMOUNT') {
    errors.push({ field: 'incomeType', message: 'Income streams must use incomeType FIXED_AMOUNT' });
  }
  if (mode === 'asset' && incomeType === 'FIXED_AMOUNT') {
    errors.push({ field: 'incomeType', message: 'FIXED_AMOUNT is only valid for income streams' });
  }

  const nonDistributing = terms.isDistributing === false || incomeType === 'NONE';
  if (!nonDistributing) {
    for (const field of REQUIRED_FIELDS_BY_TYPE[incomeType]) {
      if (isBlank(terms[field])) errors.push({ field, message: `${field} is required for ${incomeType}` });
    }
    if (incomeType === 'DIVIDEND' && mode === 'asset' && isBlank(terms.dividendPerUnit) && isBlank(terms.yieldPct)) {
      // A DIVIDEND row with neither value is only meaningful as "doesn't distribute".
      errors.push({ field: 'dividendPerUnit', message: 'dividendPerUnit or yieldPct is required for DIVIDEND' });
    }
  }

  if (!isBlank(terms.frequency) && !INCOME_FREQUENCIES.includes(terms.frequency)) {
    errors.push({ field: 'frequency', message: `frequency must be one of: ${INCOME_FREQUENCIES.join(', ')}` });
  }
  if (terms.frequency === 'AT_MATURITY' && !['FIXED_COUPON', 'FLOATING_COUPON', 'INFLATION_LINKED'].includes(incomeType)) {
    errors.push({ field: 'frequency', message: 'AT_MATURITY is only valid for bonds' });
  }
  if (!isBlank(terms.referenceIndex) && !REFERENCE_INDICES.includes(terms.referenceIndex)) {
    errors.push({ field: 'referenceIndex', message: `referenceIndex must be one of: ${REFERENCE_INDICES.join(', ')}` });
  }
  if (!isBlank(terms.issuerType) && !BOND_ISSUER_TYPES.includes(terms.issuerType)) {
    errors.push({ field: 'issuerType', message: `issuerType must be one of: ${BOND_ISSUER_TYPES.join(', ')}` });
  }

  const numericFields = [
    'amountPerPayment', 'dividendPerUnit', 'yieldPct', 'faceValuePerUnit', 'couponRate', 'spread',
    'assumedIndexRate', 'monthlyRent', 'annualIndexationPct', 'apyPct',
  ];
  for (const field of numericFields) {
    if (isBlank(terms[field])) continue;
    const n = Number(terms[field]);
    if (!Number.isFinite(n)) {
      errors.push({ field, message: `${field} must be a number` });
    } else if (n < 0 && field !== 'spread' && field !== 'assumedIndexRate' && field !== 'annualIndexationPct') {
      errors.push({ field, message: `${field} must not be negative` });
    } else if (Math.abs(n) >= 1e10) {
      errors.push({ field, message: `${field} is too large` });
    }
  }
  // Decimal(9,5) columns: |value| < 10,000
  for (const field of ['yieldPct', 'couponRate', 'spread', 'assumedIndexRate', 'annualIndexationPct', 'apyPct']) {
    if (!isBlank(terms[field]) && Math.abs(Number(terms[field])) >= 10000) {
      errors.push({ field, message: `${field} must be a percentage below 10000` });
    }
  }

  const dateFields = ['anchorPaymentDate', 'startDate', 'endDate', 'maturityDate', 'leaseEndDate'];
  for (const field of dateFields) {
    if (isBlank(terms[field])) continue;
    if (Number.isNaN(new Date(terms[field]).getTime())) errors.push({ field, message: `${field} must be a valid date` });
  }
  if (!isBlank(terms.startDate) && !isBlank(terms.endDate) && new Date(terms.endDate) < new Date(terms.startDate)) {
    errors.push({ field: 'endDate', message: 'endDate must be on or after startDate' });
  }
  if (!isBlank(terms.currency) && !/^[A-Z]{3}$/.test(String(terms.currency))) {
    errors.push({ field: 'currency', message: 'currency must be a 3-letter ISO code' });
  }
  if (mode === 'stream' && !isBlank(terms.name) && String(terms.name).length > 100) {
    errors.push({ field: 'name', message: 'name must be at most 100 characters' });
  }
  return errors;
}

// ─── Date helpers (UTC calendar days) ────────────────────────────────────────

function toDay(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(typeof value === 'string' && value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function fmtDay(d) {
  return d.toISOString().slice(0, 10);
}

function fmtMonth(d) {
  return d.toISOString().slice(0, 7);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Add `n` months, clamping the day to the target month's length (Jan 31 + 1 → Feb 28/29). */
function addMonthsClamped(d, n, day = d.getUTCDate()) {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  return new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month))));
}

function addDays(d, n) {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

function addYearsClamped(d, n) {
  return addMonthsClamped(d, 12 * n);
}

function startOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), daysInMonth(d.getUTCFullYear(), d.getUTCMonth())));
}

function monthsBetween(from, to) {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

/** Whole years elapsed between `base` and `d` (anniversary-based). */
function fullYearsBetween(base, d) {
  let years = d.getUTCFullYear() - base.getUTCFullYear();
  if (addYearsClamped(base, years) > d) years -= 1;
  return Math.max(0, years);
}

// ─── Number helpers ──────────────────────────────────────────────────────────

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'object' && typeof v.toString === 'function' ? Number(v.toString()) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(v) {
  const n = num(v);
  return n == null ? null : n / 100;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ─── Schedules ───────────────────────────────────────────────────────────────

/**
 * Dates of a periodic schedule phased on `anchor` (anchor + k·step for any
 * integer k, including negative), clipped to [from, to] inclusive.
 */
function periodicDates(anchor, frequency, from, to) {
  const out = [];
  if (!anchor || from > to) return out;
  if (frequency === 'WEEKLY') {
    const k0 = Math.ceil((from.getTime() - anchor.getTime()) / (7 * MS_PER_DAY));
    for (let k = k0; ; k++) {
      const d = addDays(anchor, 7 * k);
      if (d > to) break;
      if (d >= from) out.push(d);
    }
    return out;
  }
  const step = MONTH_STEP[frequency];
  if (!step) return out;
  const day = anchor.getUTCDate();
  // First k whose month is not before `from`'s month (one step of slack for clamping).
  let k = Math.floor(monthsBetween(anchor, from) / step) - 1;
  for (; ; k++) {
    const d = addMonthsClamped(anchor, k * step, day);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** Frequency label for an automatic dividend, derived from the last-12-month payment count. */
export function frequencyFromDividendCount(count) {
  if (!count) return 'NONE';
  if (count >= 11 && count <= 13) return 'MONTHLY';
  if (count === 4) return 'QUARTERLY';
  if (count === 2) return 'SEMIANNUAL';
  if (count === 1) return 'ANNUAL';
  return 'IRREGULAR';
}

function normalizeDividends(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((d) => ({ exDate: toDay(d?.exDate), amount: num(d?.amount) }))
    .filter((d) => d.exDate && d.amount != null && d.amount > 0)
    .sort((a, b) => b.exDate - a.exDate);
}

// ─── Per-item event generation ───────────────────────────────────────────────

/**
 * Decide how a single asset is projected.
 * Priority for stocks/ETFs: override (dividendPerUnit) > trusted SecurityMaster
 * replay > "doesn't distribute" > missing.
 */
function resolveAssetMode(asset) {
  const t = asset.terms || null;
  if (t && (t.isDistributing === false || t.incomeType === 'NONE')) return { mode: 'NONE', source: 'MANUAL' };
  if (t && t.incomeType === 'DIVIDEND' && num(t.dividendPerUnit) != null) {
    return { mode: 'DIVIDEND_OVERRIDE', source: ['STOCK', 'ETF'].includes(asset.assetClass) ? 'OVERRIDE' : 'MANUAL' };
  }
  if (t && t.incomeType === 'DIVIDEND' && num(t.yieldPct) != null) return { mode: 'CUSTOM_YIELD', source: 'MANUAL' };
  if (t && t.incomeType && t.incomeType !== 'DIVIDEND') return { mode: t.incomeType, source: 'MANUAL' };
  if (Array.isArray(asset.recentDividends)) return { mode: 'DIVIDEND_AUTO', source: 'AUTO' };
  return { mode: 'MISSING', source: 'MISSING' };
}

/**
 * Data source of one holding's projection: 'AUTO' | 'OVERRIDE' | 'MANUAL' | 'MISSING'.
 * Same rules as the breakdown row. `recentDividends` must be null unless trusted.
 */
export function resolveIncomeSource({ assetClass, terms = null, recentDividends = null } = {}) {
  return resolveAssetMode({ assetClass, terms, recentDividends }).source;
}

function bondRate(mode, t) {
  if (mode === 'FIXED_COUPON') return pct(t.couponRate) ?? 0;
  if (mode === 'FLOATING_COUPON') return (pct(t.assumedIndexRate) ?? 0) + (pct(t.spread) ?? 0);
  if (mode === 'INFLATION_LINKED') return (pct(t.couponRate) ?? 0) + (pct(t.assumedIndexRate) ?? 0);
  return 0;
}

/**
 * Generate events for one asset within [from, to].
 * Returns { events, principal, meta } where meta feeds the breakdown row.
 */
function assetEvents(asset, { mode }, from, to, asOf) {
  const t = asset.terms || {};
  const fx = num(asset.fxRate) ?? 1;
  const qty = num(asset.quantity) ?? 0;
  const value = num(asset.currentValue) ?? 0; // already in display currency
  const events = [];
  const principal = [];
  const meta = { rateOrYield: null, amountPerPayment: null, frequency: t.frequency || null, endDate: null };

  const start = toDay(t.startDate);
  const end = toDay(t.endDate);
  const lo = start && start > from ? start : from;
  let hi = end && end < to ? end : to;

  const push = (date, amount, bucket) => {
    if (date >= lo && date <= hi && amount !== 0) events.push({ date, amount, bucket });
  };

  if (mode === 'NONE' || mode === 'MISSING') return { events, principal, meta };

  if (qty <= 0 && mode !== 'INTEREST') {
    // No position → nothing to pay. Cash interest is value-based (balance × APY).
    return { events, principal, meta };
  }

  switch (mode) {
    case 'DIVIDEND_AUTO': {
      const divs = normalizeDividends(asset.recentDividends);
      const dfx = num(asset.dividendFxRate) ?? fx;
      meta.frequency = frequencyFromDividendCount(divs.length);
      const annual = divs.reduce((s, d) => s + d.amount, 0) * qty * dfx;
      meta.rateOrYield = value > 0 ? annual / value : null;
      for (const d of divs) {
        for (let k = 1; ; k++) {
          const date = addDays(addYearsClamped(d.exDate, k), PAYMENT_LAG_DAYS);
          if (date > hi) break;
          push(date, d.amount * qty * dfx, 'dividend');
        }
      }
      break;
    }
    case 'DIVIDEND_OVERRIDE': {
      const freq = t.frequency && PAYMENTS_PER_YEAR[t.frequency] ? t.frequency : 'QUARTERLY';
      meta.frequency = freq;
      const annual = num(t.dividendPerUnit) * qty * fx;
      const perPayment = annual / PAYMENTS_PER_YEAR[freq];
      meta.amountPerPayment = perPayment;
      meta.rateOrYield = value > 0 ? annual / value : null;
      const lastEx = normalizeDividends(asset.recentDividends)[0];
      const anchor = toDay(t.anchorPaymentDate)
        || (lastEx ? addDays(lastEx.exDate, PAYMENT_LAG_DAYS) : null)
        || endOfMonth(asOf);
      for (const d of periodicDates(anchor, freq, lo, hi)) push(d, perPayment, 'dividend');
      break;
    }
    case 'CUSTOM_YIELD': {
      const freq = t.frequency && PAYMENTS_PER_YEAR[t.frequency] ? t.frequency : 'MONTHLY';
      meta.frequency = freq;
      const y = pct(t.yieldPct) ?? 0;
      const perPayment = (y * value) / PAYMENTS_PER_YEAR[freq];
      meta.rateOrYield = y;
      meta.amountPerPayment = perPayment;
      const anchor = toDay(t.anchorPaymentDate) || endOfMonth(asOf);
      for (const d of periodicDates(anchor, freq, lo, hi)) push(d, perPayment, 'dividend');
      break;
    }
    case 'FIXED_COUPON':
    case 'FLOATING_COUPON':
    case 'INFLATION_LINKED': {
      const maturity = toDay(t.maturityDate);
      const face = (num(t.faceValuePerUnit) ?? 0) * qty * fx;
      const rate = bondRate(mode, t);
      meta.rateOrYield = rate;
      meta.endDate = maturity ? fmtDay(maturity) : null;
      if (maturity && maturity < hi) hi = maturity;
      if (t.frequency === 'AT_MATURITY') {
        meta.frequency = 'AT_MATURITY';
        if (maturity) {
          // Accrued (compounded) interest from the anchor/start date — or today — to maturity.
          const base = toDay(t.anchorPaymentDate) || start || asOf;
          const whole = maturity > base ? fullYearsBetween(base, maturity) : 0;
          const rest = maturity > base ? (maturity - addYearsClamped(base, whole)) / (365 * MS_PER_DAY) : 0;
          const years = whole + rest;
          const amount = face * (Math.pow(1 + rate, years) - 1);
          meta.amountPerPayment = amount;
          push(maturity, amount, 'coupon');
        }
      } else {
        const freq = PAYMENTS_PER_YEAR[t.frequency] ? t.frequency : 'SEMIANNUAL';
        meta.frequency = freq;
        const perPayment = (face * rate) / PAYMENTS_PER_YEAR[freq];
        meta.amountPerPayment = perPayment;
        const anchor = toDay(t.anchorPaymentDate) || maturity || endOfMonth(asOf);
        for (const d of periodicDates(anchor, freq, lo, hi)) push(d, perPayment, 'coupon');
      }
      if (maturity && maturity >= from && maturity <= to) principal.push({ date: maturity, amount: face });
      break;
    }
    case 'RENT': {
      const lease = toDay(t.leaseEndDate);
      meta.endDate = lease ? fmtDay(lease) : end ? fmtDay(end) : null;
      if (lease && lease < hi) hi = lease;
      meta.frequency = 'MONTHLY';
      const rent = (num(t.monthlyRent) ?? 0) * fx;
      const idx = pct(t.annualIndexationPct) ?? 0;
      meta.amountPerPayment = rent;
      meta.rateOrYield = value > 0 ? (rent * 12) / value : null;
      const anchor = toDay(t.anchorPaymentDate) || start || endOfMonth(asOf);
      const base = start || toDay(t.anchorPaymentDate) || asOf;
      for (const d of periodicDates(anchor, 'MONTHLY', lo, hi)) {
        push(d, rent * Math.pow(1 + idx, fullYearsBetween(base, d)), 'rent');
      }
      break;
    }
    case 'INTEREST': {
      const apy = pct(t.apyPct) ?? 0;
      meta.frequency = 'MONTHLY';
      meta.rateOrYield = apy;
      const monthly = (value * apy) / 12;
      meta.amountPerPayment = monthly;
      const anchor = toDay(t.anchorPaymentDate) || endOfMonth(asOf);
      for (const d of periodicDates(anchor, 'MONTHLY', lo, hi)) push(d, monthly, 'interest');
      break;
    }
    default:
      break;
  }
  if (!meta.endDate && end) meta.endDate = fmtDay(end);
  return { events, principal, meta };
}

function streamEvents(stream, from, to) {
  const t = stream.terms || stream;
  const fx = num(stream.fxRate) ?? 1;
  const events = [];
  const start = toDay(t.startDate);
  const end = toDay(t.endDate);
  const meta = {
    rateOrYield: null,
    amountPerPayment: (num(t.amountPerPayment) ?? 0) * fx,
    frequency: t.frequency || null,
    endDate: end ? fmtDay(end) : null,
  };
  if (t.isDistributing === false || !PAYMENTS_PER_YEAR[t.frequency]) return { events, meta };
  const lo = start && start > from ? start : from;
  const hi = end && end < to ? end : to;
  const anchor = toDay(t.anchorPaymentDate) || start || from;
  const idx = pct(t.annualIndexationPct) ?? 0;
  const base = start || anchor;
  for (const d of periodicDates(anchor, t.frequency, lo, hi)) {
    const amount = meta.amountPerPayment * Math.pow(1 + idx, fullYearsBetween(base, d));
    if (amount !== 0) events.push({ date: d, amount, bucket: 'other' });
  }
  return { events, meta };
}

// ─── Status rules ────────────────────────────────────────────────────────────

function assetStatus(asset, mode, asOf) {
  const t = asset.terms || {};
  const qty = num(asset.quantity) ?? 0;
  const maturity = toDay(t.maturityDate);
  if (['FIXED_COUPON', 'FLOATING_COUPON', 'INFLATION_LINKED'].includes(mode) && maturity && maturity < asOf && qty > 0) {
    return 'MATURED_UNREDEEMED';
  }
  const lease = toDay(t.leaseEndDate);
  const end = toDay(t.endDate);
  if ((mode === 'RENT' && lease && lease < asOf) || (end && end < asOf)) return 'ENDED';
  if (['FLOATING_COUPON', 'INFLATION_LINKED'].includes(mode)) {
    const updated = toDay(t.updatedAt);
    if (updated && (asOf - updated) / MS_PER_DAY > STALE_RATE_DAYS) return 'STALE_RATE';
  }
  return 'OK';
}

function streamStatus(stream, asOf) {
  const t = stream.terms || stream;
  const end = toDay(t.endDate);
  return end && end < asOf ? 'ENDED' : 'OK';
}

// ─── Grouping (#83) ──────────────────────────────────────────────────────────

/** Most severe first: the group shows the worst status among its holdings. */
export const STATUS_SEVERITY = ['MATURED_UNREDEEMED', 'STALE_RATE', 'ENDED', 'OK'];

/** Asset classes whose group rate is the shared coupon / APY (or a range), not income ÷ value. */
const RATE_CLASSES = ['BOND', 'CASH'];

function severity(status) {
  const i = STATUS_SEVERITY.indexOf(status);
  return i === -1 ? STATUS_SEVERITY.length : i;
}

/** The shared value when every entry agrees, 'MIXED' when they don't, `empty` when there's none. */
function sharedOrMixed(values, empty = null) {
  if (values.length === 0) return empty;
  return values.every((v) => v === values[0]) ? values[0] : 'MIXED';
}

/** Internal grouping key: one group per symbol (and asset class, so an oddly named manual asset never joins a security). */
function groupId(row) {
  return `${row.assetClass || ''}::${row.symbol || row.label}`;
}

/** A breakdown child row for a holding with no usable data (`missing[]` entry). */
function missingChildRow(m) {
  return {
    kind: 'ASSET',
    portfolioItemId: m.portfolioItemId,
    streamId: null,
    incomeTermsId: null,
    label: m.label,
    symbol: m.symbol,
    securityName: m.securityName ?? null,
    assetClass: m.assetClass,
    accountId: m.accountId ?? null,
    accountName: m.accountName ?? null,
    quantity: m.quantity ?? null,
    currentValue: m.currentValue ?? null,
    currency: m.currency ?? null,
    incomeType: DEFAULT_INCOME_TYPE_BY_CLASS[m.assetClass] || 'DIVIDEND',
    source: 'MISSING',
    rateOrYield: null,
    amountPerPayment: null,
    frequency: null,
    nextPaymentDate: null,
    endDate: null,
    status: 'OK',
    horizonTotal: 0,
    next12mTotal: 0,
  };
}

/**
 * Group breakdown rows by holding: one group per symbol (securities, bonds,
 * real estate, other) and — because a cash holding's symbol is "Cash EUR" —
 * one per cash currency. Streams are not grouped (the caller keeps them flat).
 * Holdings with no usable data (`missing`) become MISSING children, so a group
 * can be partly configured.
 *
 * @param {Array} items    `project().items` (streams are ignored)
 * @param {Array} [missing] `project().missing`
 * @returns {Array} groups sorted by horizonTotal desc, then label
 */
export function groupItems(items = [], missing = []) {
  const map = new Map();
  const add = (row) => {
    const id = groupId(row);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  };
  for (const row of items) if (row.kind === 'ASSET') add(row);
  for (const m of missing) add(missingChildRow(m));

  const groups = [];
  for (const children of map.values()) {
    children.sort((a, b) => b.horizonTotal - a.horizonTotal
      || String(a.accountName ?? '').localeCompare(String(b.accountName ?? '')));
    const first = children[0];
    const assetClass = first.assetClass;
    const configured = children.filter((c) => c.source !== 'MISSING');
    const sum = (key) => children.reduce((s, c) => s + (num(c[key]) ?? 0), 0);
    const horizonTotal = round2(sum('horizonTotal'));
    const next12mTotal = round2(sum('next12mTotal'));
    const currentValue = round2(sum('currentValue'));

    let rateOrYield = null;
    let rateRange = null;
    if (RATE_CLASSES.includes(assetClass)) {
      const rates = configured.map((c) => c.rateOrYield).filter((r) => r != null);
      if (rates.length > 0) {
        const min = Math.min(...rates);
        const max = Math.max(...rates);
        if (min === max) rateOrYield = min;
        else rateRange = [min, max];
      }
    } else if (currentValue > 0) {
      rateOrYield = Math.round((next12mTotal / currentValue) * 1e6) / 1e6;
    } else if (children.length === 1) {
      rateOrYield = first.rateOrYield;
    }

    const nextDates = children.map((c) => c.nextPaymentDate).filter(Boolean).sort();
    const endDates = children.map((c) => c.endDate).filter(Boolean).sort();
    const worst = children.reduce((w, c) => (severity(c.status) < severity(w) ? c.status : w), 'OK');
    const names = [...new Set(children.map((c) => c.securityName).filter(Boolean))];

    groups.push({
      groupKey: first.symbol || first.label,
      kind: assetClass === 'CASH' ? 'CASH' : 'SECURITY',
      label: names[0] || first.symbol || first.label,
      symbol: first.symbol,
      assetClass,
      accountCount: children.length,
      portfolioItemIds: children.map((c) => c.portfolioItemId),
      quantity: Math.round(sum('quantity') * 1e8) / 1e8,
      currentValue,
      currency: sharedOrMixed(children.map((c) => c.currency).filter(Boolean)),
      incomeType: sharedOrMixed(configured.map((c) => c.incomeType), first.incomeType),
      source: sharedOrMixed(children.map((c) => c.source)),
      frequency: sharedOrMixed(configured.map((c) => c.frequency).filter(Boolean)),
      rateOrYield,
      rateRange,
      amountPerPayment: children.length === 1 ? first.amountPerPayment : null,
      nextPaymentDate: nextDates[0] ?? null,
      endDate: endDates[endDates.length - 1] ?? null,
      status: worst,
      statusCount: children.filter((c) => c.status !== 'OK').length,
      configured: configured.length === children.length,
      inCoverage: children.some((c) => COVERAGE_ASSET_CLASSES.includes(c.assetClass)),
      horizonTotal,
      next12mTotal,
      children,
    });
  }
  groups.sort((a, b) => b.horizonTotal - a.horizonTotal || String(a.label).localeCompare(String(b.label)));
  return groups;
}

/** One missing-data entry per symbol (opens the Income Terms modal in group mode). */
export function groupMissing(missing = []) {
  const map = new Map();
  for (const m of missing) {
    const id = groupId(m);
    if (!map.has(id)) {
      map.set(id, {
        groupKey: m.symbol || m.label,
        symbol: m.symbol,
        label: m.securityName || m.symbol || m.label,
        assetClass: m.assetClass,
        portfolioItemIds: [],
        reason: m.reason,
      });
    }
    const g = map.get(id);
    g.portfolioItemIds.push(m.portfolioItemId);
    // "No terms" is the more actionable reason when accounts disagree.
    if (m.reason === 'NO_TERMS') g.reason = 'NO_TERMS';
  }
  return [...map.values()];
}

/**
 * Merge upcoming payment events of the same holding group (symbol), date and
 * source into one line with the summed amount and the accounts that pay it.
 * Streams stay one line each. Call on the FULL event list, before taking the top N.
 */
function mergeUpcoming(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.kind === 'STREAM' ? `S:${e.refId}:${e.date}:${e.source}` : `A:${e.groupId}:${e.date}:${e.source}`;
    if (!map.has(key)) {
      map.set(key, {
        date: e.date,
        kind: e.kind,
        groupKey: e.kind === 'STREAM' ? null : e.groupKey,
        refId: e.kind === 'STREAM' ? e.refId : null,
        refIds: [],
        label: e.kind === 'STREAM' ? e.label : e.groupLabel,
        amount: 0,
        source: e.source,
        accounts: [],
      });
    }
    const m = map.get(key);
    m.amount += e.amount;
    if (!m.refIds.includes(e.refId)) m.refIds.push(e.refId);
    if (e.accountName && !m.accounts.includes(e.accountName)) m.accounts.push(e.accountName);
  }
  return [...map.values()];
}

// ─── project() ───────────────────────────────────────────────────────────────

function emptyBuckets() {
  return { dividend: 0, coupon: 0, rent: 0, interest: 0, other: 0, total: 0 };
}

function roundBuckets(b) {
  const out = {};
  for (const k of Object.keys(b)) out[k] = typeof b[k] === 'number' ? round2(b[k]) : b[k];
  return out;
}

/**
 * Project passive income.
 *
 * @param {Object}  input
 * @param {Array}   input.assets   [{ id, label, symbol?, assetClass, quantity, currentValue (display ccy),
 *                                    fxRate (terms ccy → display), dividendFxRate? (dividend ccy → display),
 *                                    terms: IncomeTerms|null, recentDividends: [{exDate, amount}]|null,
 *                                    accountId?, accountName?, currency?, securityName? }]
 *                                  `recentDividends` must be null unless SecurityMaster marks them trusted.
 *                                  The optional fields feed the grouped view (#83): `groups`,
 *                                  `upcomingPaymentsGrouped`, `missingGroups`, group-level coverage.
 * @param {Array}   input.streams  [{ id, name, categoryName?, fxRate, terms: IncomeTerms (FIXED_AMOUNT) }]
 * @param {Date|string} input.asOf
 * @param {number}  input.horizon  12 | 24 | 36
 * @param {string}  [input.displayCurrency]
 * @returns {Object} see docs/specs/api — monthly, yearly, items, groups, upcomingPayments,
 *                   upcomingPaymentsGrouped, maturityLadder, missing, missingGroups, totals
 */
export function project({ assets = [], streams = [], asOf, horizon = 12, displayCurrency = null } = {}) {
  const today = toDay(asOf || new Date());
  const months = HORIZONS.includes(Number(horizon)) ? Number(horizon) : 12;
  const windowStart = addMonthsClamped(startOfMonth(today), 1, 1);
  const windowEnd = addDays(addMonthsClamped(windowStart, months, 1), -1); // inclusive
  const next12End = addDays(addMonthsClamped(windowStart, 12, 1), -1);

  const monthKeys = [];
  for (let i = 0; i < months; i++) monthKeys.push(fmtMonth(addMonthsClamped(windowStart, i, 1)));
  const monthly = new Map(monthKeys.map((m) => [m, { month: m, ...emptyBuckets() }]));
  const yearly = [];
  for (let y = 1; y <= months / 12; y++) yearly.push({ year: y, ...emptyBuckets() });

  const items = [];
  const upcoming = [];
  const ladder = new Map();
  const missing = [];
  let investmentValue = 0;
  let configured = 0;
  let coverageTotal = 0;

  const accumulate = (events, row, ref) => {
    for (const e of events) {
      if (e.date >= windowStart) {
        const key = fmtMonth(e.date);
        const m = monthly.get(key);
        if (m) {
          m[e.bucket] += e.amount;
          m.total += e.amount;
          const yi = Math.floor(monthsBetween(windowStart, e.date) / 12);
          yearly[yi][e.bucket] += e.amount;
          yearly[yi].total += e.amount;
          row.horizonTotal += e.amount;
          if (e.date <= next12End) row.next12mTotal += e.amount;
        }
      }
      if (!row.nextPaymentDate || e.date < toDay(row.nextPaymentDate)) row.nextPaymentDate = fmtDay(e.date);
      upcoming.push({
        date: fmtDay(e.date),
        kind: ref.kind,
        refId: ref.refId,
        label: ref.label,
        amount: e.amount,
        source: e.bucket,
        groupId: ref.groupId ?? null,
        groupKey: ref.groupKey ?? null,
        groupLabel: ref.groupLabel ?? null,
        accountName: ref.accountName ?? null,
      });
    }
  };

  for (const asset of assets) {
    const resolved = resolveAssetMode(asset);
    const inCoverage = COVERAGE_ASSET_CLASSES.includes(asset.assetClass);
    const value = num(asset.currentValue) ?? 0;
    const qty = num(asset.quantity) ?? 0;
    // Per-holding fields the grouped view needs (#83).
    const holding = {
      securityName: asset.securityName ?? null,
      accountId: asset.accountId ?? null,
      accountName: asset.accountName ?? null,
      quantity: qty,
      currentValue: round2(value),
      currency: asset.currency ?? null,
    };
    if (value > 0) investmentValue += value;
    if (inCoverage && qty > 0) {
      coverageTotal += 1;
      if (resolved.mode !== 'MISSING') configured += 1;
    }
    if (resolved.mode === 'MISSING') {
      if (inCoverage && qty > 0) {
        missing.push({
          portfolioItemId: asset.id,
          symbol: asset.symbol || asset.label,
          label: asset.label,
          assetClass: asset.assetClass,
          reason: asset.hasSecurityData ? 'UNTRUSTED_DIVIDEND' : 'NO_TERMS',
          ...holding,
        });
      }
      continue;
    }
    // Cash / other rows without terms aren't income-producing — don't list them.
    const { events, principal, meta } = assetEvents(asset, resolved, today, windowEnd, today);
    const incomeType = resolved.mode === 'DIVIDEND_AUTO' || resolved.mode === 'DIVIDEND_OVERRIDE'
      ? 'DIVIDEND'
      : resolved.mode === 'CUSTOM_YIELD' && asset.terms?.incomeType === 'DIVIDEND' ? 'DIVIDEND' : resolved.mode;
    const row = {
      kind: 'ASSET',
      portfolioItemId: asset.id,
      streamId: null,
      incomeTermsId: asset.terms?.id ?? null,
      label: asset.label,
      symbol: asset.symbol || null,
      assetClass: asset.assetClass || null,
      ...holding,
      incomeType,
      source: resolved.source,
      rateOrYield: meta.rateOrYield,
      amountPerPayment: meta.amountPerPayment != null ? round2(meta.amountPerPayment) : null,
      frequency: meta.frequency,
      nextPaymentDate: null,
      endDate: meta.endDate,
      status: assetStatus(asset, resolved.mode, today),
      horizonTotal: 0,
      next12mTotal: 0,
    };
    accumulate(events, row, {
      kind: 'ASSET',
      refId: asset.id,
      label: asset.label,
      groupId: groupId(row),
      groupKey: asset.symbol || asset.label,
      groupLabel: holding.securityName || asset.symbol || asset.label,
      accountName: holding.accountName,
    });
    for (const p of principal) {
      const y = p.date.getUTCFullYear();
      if (!ladder.has(y)) ladder.set(y, { year: y, principal: 0, items: [] });
      const entry = ladder.get(y);
      entry.principal += p.amount;
      if (!entry.items.includes(asset.id)) entry.items.push(asset.id);
    }
    row.horizonTotal = round2(row.horizonTotal);
    row.next12mTotal = round2(row.next12mTotal);
    items.push(row);
  }

  for (const stream of streams) {
    const { events, meta } = streamEvents(stream, today, windowEnd);
    const row = {
      kind: 'STREAM',
      portfolioItemId: null,
      streamId: stream.id,
      incomeTermsId: stream.id,
      label: stream.name || stream.terms?.name || '',
      symbol: null,
      assetClass: null,
      categoryName: stream.categoryName || null,
      incomeType: 'FIXED_AMOUNT',
      source: 'MANUAL',
      rateOrYield: null,
      amountPerPayment: round2(meta.amountPerPayment),
      frequency: meta.frequency,
      nextPaymentDate: null,
      endDate: meta.endDate,
      status: streamStatus(stream, today),
      horizonTotal: 0,
      next12mTotal: 0,
    };
    accumulate(events, row, { kind: 'STREAM', refId: stream.id, label: row.label });
    row.horizonTotal = round2(row.horizonTotal);
    row.next12mTotal = round2(row.next12mTotal);
    items.push(row);
  }

  const rawMonthly = [...monthly.values()];
  const monthlyArr = rawMonthly.map(roundBuckets);
  const first12 = rawMonthly.slice(0, 12);
  const next12mIncome = first12.reduce((s, m) => s + m.total, 0);
  const next12mOtherIncome = first12.reduce((s, m) => s + m.other, 0);
  const next12mInvestmentIncome = next12mIncome - next12mOtherIncome;

  const byDateThenAmount = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount);
  upcoming.sort(byDateThenAmount);
  items.sort((a, b) => b.horizonTotal - a.horizonTotal || String(a.label).localeCompare(String(b.label)));

  // Grouped view (#83): one row per symbol / cash currency. Coverage counts
  // groups; a group is configured only when none of its holdings is missing.
  const groups = groupItems(items, missing);
  const coverageGroups = groups.filter((g) => g.inCoverage && g.quantity > 0);
  const upcomingGrouped = mergeUpcoming(upcoming).sort(byDateThenAmount);

  return {
    displayCurrency,
    asOf: fmtDay(today),
    horizon: months,
    window: { start: fmtDay(windowStart), end: fmtDay(windowEnd) },
    totals: {
      next12mIncome: round2(next12mIncome),
      next12mInvestmentIncome: round2(next12mInvestmentIncome),
      next12mOtherIncome: round2(next12mOtherIncome),
      monthlyAverage: round2(next12mIncome / 12),
      investmentValue: round2(investmentValue),
      yieldOnValue: investmentValue > 0 ? Math.round((next12mInvestmentIncome / investmentValue) * 1e6) / 1e6 : null,
      coverage: {
        configured: coverageGroups.filter((g) => g.configured).length,
        total: coverageGroups.length,
      },
      coverageByHolding: { configured, total: coverageTotal },
    },
    monthly: monthlyArr,
    yearly: yearly.map(roundBuckets),
    items,
    groups,
    upcomingPayments: upcoming.slice(0, 10).map((u) => ({
      date: u.date,
      kind: u.kind,
      refId: u.refId,
      label: u.label,
      amount: round2(u.amount),
      source: u.source,
    })),
    upcomingPaymentsGrouped: upcomingGrouped.slice(0, 10).map((u) => ({ ...u, amount: round2(u.amount) })),
    missingGroups: groupMissing(missing),
    maturityLadder: [...ladder.values()]
      .sort((a, b) => a.year - b.year)
      .map((l) => ({ ...l, principal: round2(l.principal) })),
    missing,
  };
}
