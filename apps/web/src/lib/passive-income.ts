import type {
  IncomeAssetClass,
  IncomeFrequency,
  IncomeType,
  IncomeSourceBucket,
} from '@/types/passive-income';

/**
 * Client-side helpers for Passive Income (#77).
 *
 * The authoritative classification and projection live in
 * `@bliss/shared/portfolio` (API side). The web bundle doesn't depend on that
 * package, so the few rules the UI needs up front (which rows get an
 * "Income terms" action, which income types a form offers, the modal's live
 * preview) are mirrored here. The API re-validates everything on save.
 */

interface CategoryLike {
  type?: string | null;
  group?: string | null;
  processingHint?: string | null;
  defaultCategoryCode?: string | null;
}

/** Mirrors `classifyIncomeAsset` in @bliss/shared/portfolio (without SecurityMaster data). */
export function classifyIncomeCategory(category: CategoryLike | null | undefined): IncomeAssetClass | null {
  if (!category) return null;
  const { type, group, processingHint, defaultCategoryCode: code } = category;
  if (processingHint === 'CASH') return 'CASH';
  if (type !== 'Investments' && type !== 'Asset') return null;
  if (processingHint === 'API_CRYPTO') return null;
  if (code === 'COMMODITIES' || group === 'Commodities') return null;
  if (code === 'COLLECTIBLE' || code === 'VEHICLE' || group === 'Collectible' || group === 'Depreciating assets') {
    return null;
  }
  if (code === 'GOVERNMENT_BONDS' || code === 'CORPORATE_BONDS' || group === 'Bonds') return 'BOND';
  if (code === 'REAL_ESTATE' || group === 'Real Estate') return 'REAL_ESTATE';
  if (processingHint === 'API_STOCK') return 'STOCK';
  if (processingHint === 'API_FUND') return code === 'ETFS' || group === 'ETFs' ? 'ETF' : 'FUND';
  return 'OTHER';
}

export function canHoldIncomeTerms(category: CategoryLike | null | undefined): boolean {
  return classifyIncomeCategory(category) !== null;
}

/** Income types offered by the Income Terms modal, per asset class (first = default). */
export const INCOME_TYPES_BY_CLASS: Record<IncomeAssetClass, IncomeType[]> = {
  STOCK: ['DIVIDEND'],
  ETF: ['DIVIDEND'],
  FUND: ['DIVIDEND', 'CUSTOM_YIELD'],
  BOND: ['FIXED_COUPON', 'FLOATING_COUPON', 'INFLATION_LINKED'],
  REAL_ESTATE: ['RENT'],
  CASH: ['INTEREST'],
  OTHER: ['CUSTOM_YIELD', 'DIVIDEND', 'FIXED_COUPON'],
};

export const BOND_TYPES: IncomeType[] = ['FIXED_COUPON', 'FLOATING_COUPON', 'INFLATION_LINKED'];

export const PERIODIC_FREQUENCIES: IncomeFrequency[] = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'];

export const STREAM_FREQUENCIES: IncomeFrequency[] = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'];

export const BOND_FREQUENCIES: IncomeFrequency[] = [...PERIODIC_FREQUENCIES, 'AT_MATURITY'];

export const REFERENCE_INDICES = ['SOFR', 'EURIBOR', 'CDI', 'SELIC', 'IPCA', 'CPI', 'OTHER'] as const;

export const PAYMENTS_PER_YEAR: Record<string, number> = {
  WEEKLY: 52,
  MONTHLY: 12,
  QUARTERLY: 4,
  SEMIANNUAL: 2,
  ANNUAL: 1,
};

/** Chart/legend order and dataviz token per projection bucket. */
export const INCOME_BUCKETS: { key: IncomeSourceBucket; color: string }[] = [
  { key: 'dividend', color: 'hsl(var(--dataviz-1))' },
  { key: 'coupon', color: 'hsl(var(--dataviz-5))' },
  { key: 'rent', color: 'hsl(var(--dataviz-3))' },
  { key: 'interest', color: 'hsl(var(--dataviz-2))' },
  { key: 'other', color: 'hsl(var(--dataviz-7))' },
];

export const ACTUALS_COLOR = 'hsl(var(--dataviz-8))';

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDay(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addMonths(d: Date, n: number, day = d.getUTCDate()): Date {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}

/** Next date on a schedule phased on `anchor` that is on/after `from`. */
export function nextScheduledDate(anchor: Date, frequency: string, from: Date): Date | null {
  if (frequency === 'WEEKLY') {
    const weeks = Math.ceil((from.getTime() - anchor.getTime()) / (7 * 86400000));
    return new Date(anchor.getTime() + weeks * 7 * 86400000);
  }
  const step = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 }[frequency];
  if (!step) return null;
  const day = anchor.getUTCDate();
  const diff = (from.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (from.getUTCMonth() - anchor.getUTCMonth());
  for (let k = Math.floor(diff / step) - 1; k < Math.floor(diff / step) + 3; k++) {
    const d = addMonths(anchor, k * step, day);
    if (d >= from) return d;
  }
  return null;
}

export interface IncomePreviewInput {
  incomeType: IncomeType;
  isDistributing?: boolean;
  frequency?: string | null;
  anchorPaymentDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  amountPerPayment?: number | string | null;
  dividendPerUnit?: number | string | null;
  yieldPct?: number | string | null;
  faceValuePerUnit?: number | string | null;
  couponRate?: number | string | null;
  spread?: number | string | null;
  assumedIndexRate?: number | string | null;
  maturityDate?: string | null;
  monthlyRent?: number | string | null;
  leaseEndDate?: string | null;
  apyPct?: number | string | null;
}

export interface IncomePreview {
  annual: number;
  nextPayment: string | null;
  endDate: string | null;
}

/**
 * Rough annual income + next payment for the modal's live preview
 * ("≈ 1,240 / year · next payment 15 Nov · matures 2029"). Amounts are in the
 * terms' own currency. The page itself uses the API projection.
 */
export function previewIncome(
  v: IncomePreviewInput,
  ctx: { quantity?: number; currentValue?: number; today?: Date } = {},
): IncomePreview | null {
  const today = ctx.today ?? new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const qty = ctx.quantity ?? 0;
  const value = ctx.currentValue ?? 0;
  if (v.isDistributing === false || v.incomeType === 'NONE') return { annual: 0, nextPayment: null, endDate: null };

  let annual: number | null = null;
  let freq = v.frequency || null;
  let anchor = toDay(v.anchorPaymentDate) || toDay(v.startDate);
  let endDate = v.endDate || null;

  switch (v.incomeType) {
    case 'DIVIDEND': {
      const perUnit = num(v.dividendPerUnit);
      const y = num(v.yieldPct);
      if (perUnit != null) annual = perUnit * qty;
      else if (y != null) annual = (y / 100) * value;
      freq = freq || 'QUARTERLY';
      break;
    }
    case 'CUSTOM_YIELD': {
      const y = num(v.yieldPct);
      if (y != null) annual = (y / 100) * value;
      freq = freq || 'MONTHLY';
      break;
    }
    case 'FIXED_COUPON':
    case 'FLOATING_COUPON':
    case 'INFLATION_LINKED': {
      const face = num(v.faceValuePerUnit);
      const rate = v.incomeType === 'FIXED_COUPON'
        ? num(v.couponRate)
        : v.incomeType === 'FLOATING_COUPON'
          ? (num(v.assumedIndexRate) ?? 0) + (num(v.spread) ?? 0)
          : (num(v.couponRate) ?? 0) + (num(v.assumedIndexRate) ?? 0);
      if (face != null && rate != null) annual = face * qty * (rate / 100);
      endDate = v.maturityDate || null;
      anchor = anchor || toDay(v.maturityDate);
      if (freq === 'AT_MATURITY') {
        return { annual: annual ?? 0, nextPayment: v.maturityDate || null, endDate };
      }
      break;
    }
    case 'RENT': {
      const rent = num(v.monthlyRent);
      if (rent != null) annual = rent * 12;
      freq = 'MONTHLY';
      endDate = v.leaseEndDate || endDate;
      break;
    }
    case 'INTEREST': {
      const apy = num(v.apyPct);
      if (apy != null) annual = value * (apy / 100);
      freq = 'MONTHLY';
      break;
    }
    case 'FIXED_AMOUNT': {
      const amount = num(v.amountPerPayment);
      if (amount != null && freq && PAYMENTS_PER_YEAR[freq]) annual = amount * PAYMENTS_PER_YEAR[freq];
      break;
    }
    default:
      break;
  }
  if (annual == null) return null;

  const start = toDay(v.startDate);
  const effectiveFrom = start && start > from ? start : from;
  const base = anchor || new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  const next = freq ? nextScheduledDate(base, freq, effectiveFrom) : null;
  const end = toDay(endDate);
  return {
    annual,
    nextPayment: next && (!end || next <= end) ? next.toISOString().slice(0, 10) : null,
    endDate,
  };
}
