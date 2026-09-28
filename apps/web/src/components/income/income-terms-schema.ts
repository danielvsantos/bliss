import * as z from 'zod';
import type { IncomeTermsRequest, IncomeType, IncomeTerms } from '@/types/passive-income';

/**
 * Income Terms form schema (Passive Income #77). Mirrors
 * `validateIncomeTerms()` in @bliss/shared/portfolio — the API re-validates.
 * Form values are strings (as typed in inputs); `toRequest()` converts them.
 * Messages are i18n keys under `incomeTerms.errors.*`.
 */

export type IncomeTermsMode = 'asset' | 'stream';

export const INCOME_TYPE_VALUES = [
  'DIVIDEND', 'FIXED_COUPON', 'FLOATING_COUPON', 'INFLATION_LINKED', 'RENT',
  'INTEREST', 'CUSTOM_YIELD', 'FIXED_AMOUNT', 'NONE',
] as const;

export const REQUIRED_BY_TYPE: Record<IncomeType, string[]> = {
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

const NUMERIC = [
  'amountPerPayment', 'dividendPerUnit', 'yieldPct', 'faceValuePerUnit', 'couponRate', 'spread',
  'assumedIndexRate', 'monthlyRent', 'annualIndexationPct', 'apyPct',
] as const;
const SIGNED = new Set(['spread', 'assumedIndexRate', 'annualIndexationPct']);
const DATES = ['anchorPaymentDate', 'startDate', 'endDate', 'maturityDate', 'leaseEndDate'] as const;

const str = z.string().optional().default('');

export const incomeTermsFormSchema = z
  .object({
    mode: z.enum(['asset', 'stream']),
    incomeType: z.enum(INCOME_TYPE_VALUES),
    isDistributing: z.boolean().default(true),
    applyToSymbol: z.boolean().default(false),
    name: str,
    categoryId: str,
    frequency: str,
    currency: str,
    anchorPaymentDate: str,
    startDate: str,
    endDate: str,
    amountPerPayment: str,
    dividendPerUnit: str,
    yieldPct: str,
    issuerType: str,
    faceValuePerUnit: str,
    couponRate: str,
    referenceIndex: str,
    spread: str,
    assumedIndexRate: str,
    maturityDate: str,
    monthlyRent: str,
    leaseEndDate: str,
    annualIndexationPct: str,
    apyPct: str,
  })
  .superRefine((v, ctx) => {
    const values = v as unknown as Record<string, string>;
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (v.mode === 'stream') {
      if (v.incomeType !== 'FIXED_AMOUNT') issue('incomeType', 'incomeTerms.errors.invalid');
      if (!v.categoryId) issue('categoryId', 'incomeTerms.errors.required');
    }
    const distributing = v.isDistributing && v.incomeType !== 'NONE';
    if (distributing) {
      for (const field of REQUIRED_BY_TYPE[v.incomeType]) {
        if (!values[field]) issue(field, 'incomeTerms.errors.required');
      }
      if (v.incomeType === 'DIVIDEND' && v.mode === 'asset' && !v.dividendPerUnit && !v.yieldPct) {
        issue('dividendPerUnit', 'incomeTerms.errors.required');
      }
    }
    for (const field of NUMERIC) {
      const raw = values[field];
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) issue(field, 'incomeTerms.errors.number');
      else if (n < 0 && !SIGNED.has(field)) issue(field, 'incomeTerms.errors.negative');
    }
    for (const field of DATES) {
      if (values[field] && Number.isNaN(new Date(values[field]).getTime())) issue(field, 'incomeTerms.errors.date');
    }
    if (v.startDate && v.endDate && v.endDate < v.startDate) issue('endDate', 'incomeTerms.errors.endBeforeStart');
    if (v.currency && !/^[A-Z]{3}$/.test(v.currency)) issue('currency', 'incomeTerms.errors.currency');
  });

export type IncomeTermsFormValues = z.input<typeof incomeTermsFormSchema>;

export function emptyFormValues(mode: IncomeTermsMode, incomeType: IncomeType): IncomeTermsFormValues {
  return {
    mode,
    incomeType,
    isDistributing: true,
    applyToSymbol: false,
    name: '',
    categoryId: '',
    frequency: mode === 'stream' ? 'MONTHLY' : '',
    currency: '',
    anchorPaymentDate: '',
    startDate: '',
    endDate: '',
    amountPerPayment: '',
    dividendPerUnit: '',
    yieldPct: '',
    issuerType: '',
    faceValuePerUnit: '',
    couponRate: '',
    referenceIndex: '',
    spread: '',
    assumedIndexRate: '',
    maturityDate: '',
    monthlyRent: '',
    leaseEndDate: '',
    annualIndexationPct: '',
    apyPct: '',
  };
}

const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '');
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Form values from a stored row (asset terms or stream). */
export function formValuesFromTerms(
  terms: Partial<IncomeTerms> & { incomeType: IncomeType },
  mode: IncomeTermsMode,
): IncomeTermsFormValues {
  return {
    ...emptyFormValues(mode, terms.incomeType),
    incomeType: terms.incomeType,
    isDistributing: terms.isDistributing !== false && terms.incomeType !== 'NONE',
    name: s(terms.name),
    categoryId: s(terms.categoryId),
    frequency: s(terms.frequency),
    currency: s(terms.currency),
    anchorPaymentDate: day(terms.anchorPaymentDate),
    startDate: day(terms.startDate),
    endDate: day(terms.endDate),
    amountPerPayment: s(terms.amountPerPayment),
    dividendPerUnit: s(terms.dividendPerUnit),
    yieldPct: s(terms.yieldPct),
    issuerType: s(terms.issuerType),
    faceValuePerUnit: s(terms.faceValuePerUnit),
    couponRate: s(terms.couponRate),
    referenceIndex: s(terms.referenceIndex),
    spread: s(terms.spread),
    assumedIndexRate: s(terms.assumedIndexRate),
    maturityDate: day(terms.maturityDate),
    monthlyRent: s(terms.monthlyRent),
    leaseEndDate: day(terms.leaseEndDate),
    annualIndexationPct: s(terms.annualIndexationPct),
    apyPct: s(terms.apyPct),
  };
}

/** Fields each income type actually sends; everything else is cleared (null). */
const FIELDS_BY_TYPE: Record<IncomeType, string[]> = {
  DIVIDEND: ['dividendPerUnit', 'yieldPct', 'frequency', 'anchorPaymentDate', 'currency'],
  FIXED_COUPON: ['issuerType', 'faceValuePerUnit', 'couponRate', 'frequency', 'maturityDate', 'anchorPaymentDate', 'currency'],
  FLOATING_COUPON: ['issuerType', 'faceValuePerUnit', 'referenceIndex', 'spread', 'assumedIndexRate', 'frequency', 'maturityDate', 'anchorPaymentDate', 'currency'],
  INFLATION_LINKED: ['issuerType', 'faceValuePerUnit', 'couponRate', 'referenceIndex', 'assumedIndexRate', 'frequency', 'maturityDate', 'anchorPaymentDate', 'currency'],
  RENT: ['monthlyRent', 'leaseEndDate', 'annualIndexationPct', 'startDate', 'anchorPaymentDate', 'currency'],
  INTEREST: ['apyPct'],
  CUSTOM_YIELD: ['yieldPct', 'frequency', 'anchorPaymentDate'],
  FIXED_AMOUNT: ['name', 'amountPerPayment', 'frequency', 'currency', 'startDate', 'endDate', 'anchorPaymentDate', 'annualIndexationPct'],
  NONE: [],
};

const NUMERIC_SET = new Set<string>(NUMERIC);

/** Convert validated form values into the API request body. */
export function toRequest(v: IncomeTermsFormValues): IncomeTermsRequest & { categoryId?: number } {
  const values = v as unknown as Record<string, string>;
  const distributing = v.isDistributing !== false && v.incomeType !== 'NONE';
  const body: Record<string, unknown> = { incomeType: v.incomeType, isDistributing: distributing };
  if (distributing) {
    for (const field of FIELDS_BY_TYPE[v.incomeType]) {
      const raw = values[field];
      if (!raw) continue;
      body[field] = NUMERIC_SET.has(field) ? Number(raw) : raw;
    }
  }
  // Every income type except cash interest can apply to all holdings of a symbol (#83).
  if (v.mode === 'asset' && v.applyToSymbol && v.incomeType !== 'INTEREST') body.applyToSymbol = true;
  if (v.mode === 'stream') {
    body.categoryId = Number(v.categoryId);
    body.name = v.name;
  }
  return body as IncomeTermsRequest & { categoryId?: number };
}

/** Map zod issues to `{ field: i18nKey }`. */
export function collectErrors(values: IncomeTermsFormValues): Record<string, string> {
  const res = incomeTermsFormSchema.safeParse(values);
  if (res.success) return {};
  const out: Record<string, string> = {};
  for (const issue of res.error.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
