import { describe, it, expect } from 'vitest';
import { collectErrors, emptyFormValues, formValuesFromTerms, toRequest } from './income-terms-schema';
import type { IncomeTerms } from '@/types/passive-income';

describe('income terms form schema', () => {
  it('requires the fields of each income type', () => {
    expect(Object.keys(collectErrors(emptyFormValues('asset', 'FIXED_COUPON'))).sort())
      .toEqual(['couponRate', 'faceValuePerUnit', 'frequency', 'maturityDate']);
    expect(Object.keys(collectErrors(emptyFormValues('asset', 'FLOATING_COUPON'))).sort())
      .toEqual(['assumedIndexRate', 'faceValuePerUnit', 'frequency', 'maturityDate']);
    expect(Object.keys(collectErrors(emptyFormValues('asset', 'RENT')))).toEqual(['monthlyRent']);
    expect(Object.keys(collectErrors(emptyFormValues('asset', 'INTEREST')))).toEqual(['apyPct']);
    expect(Object.keys(collectErrors(emptyFormValues('asset', 'CUSTOM_YIELD')))).toEqual(['yieldPct']);
    expect(Object.keys(collectErrors(emptyFormValues('asset', 'DIVIDEND')))).toEqual(['dividendPerUnit']);
    expect(Object.keys(collectErrors(emptyFormValues('stream', 'FIXED_AMOUNT'))).sort())
      .toEqual(['amountPerPayment', 'categoryId', 'currency', 'name', 'startDate']);
  });

  it('skips required fields when the asset does not distribute', () => {
    expect(collectErrors({ ...emptyFormValues('asset', 'FIXED_COUPON'), isDistributing: false })).toEqual({});
  });

  it('flags bad numbers, negative values, currency and date order', () => {
    const errors = collectErrors({
      ...emptyFormValues('stream', 'FIXED_AMOUNT'),
      name: 'Pension', categoryId: '3', frequency: 'MONTHLY',
      amountPerPayment: '-5', currency: 'eur', startDate: '2026-05-01', endDate: '2026-01-01', annualIndexationPct: 'abc',
    });
    expect(errors).toEqual({
      amountPerPayment: 'incomeTerms.errors.negative',
      annualIndexationPct: 'incomeTerms.errors.number',
      endDate: 'incomeTerms.errors.endBeforeStart',
      currency: 'incomeTerms.errors.currency',
    });
  });

  it('toRequest sends only the fields of the selected type, as numbers', () => {
    const body = toRequest({
      ...emptyFormValues('asset', 'FIXED_COUPON'),
      faceValuePerUnit: '1000', couponRate: '5.5', frequency: 'SEMIANNUAL', maturityDate: '2030-01-15',
      monthlyRent: '999', // not part of FIXED_COUPON → dropped
    });
    expect(body).toEqual({
      incomeType: 'FIXED_COUPON', isDistributing: true,
      faceValuePerUnit: 1000, couponRate: 5.5, frequency: 'SEMIANNUAL', maturityDate: '2030-01-15',
    });
  });

  it('toRequest: apply-to-symbol only for dividends; streams carry category and name', () => {
    expect(toRequest({ ...emptyFormValues('asset', 'DIVIDEND'), dividendPerUnit: '2', applyToSymbol: true })).toMatchObject({ applyToSymbol: true, dividendPerUnit: 2 });
    // #83: every type except cash interest can apply to all holdings of the symbol.
    expect(toRequest({ ...emptyFormValues('asset', 'RENT'), monthlyRent: '10', applyToSymbol: true })).toMatchObject({ applyToSymbol: true });
    expect(toRequest({ ...emptyFormValues('asset', 'INTEREST'), apyPct: '4', applyToSymbol: true })).not.toHaveProperty('applyToSymbol');
    expect(toRequest({ ...emptyFormValues('stream', 'FIXED_AMOUNT'), name: 'X', categoryId: '7', amountPerPayment: '10' }))
      .toMatchObject({ categoryId: 7, name: 'X', amountPerPayment: 10 });
    expect(toRequest({ ...emptyFormValues('asset', 'DIVIDEND'), isDistributing: false, dividendPerUnit: '2' }))
      .toEqual({ incomeType: 'DIVIDEND', isDistributing: false });
  });

  it('formValuesFromTerms round-trips a stored row', () => {
    const terms = {
      id: 1, incomeType: 'RENT', isDistributing: true, monthlyRent: 1200, leaseEndDate: '2028-01-31T00:00:00.000Z',
      annualIndexationPct: 3, startDate: null,
    } as unknown as IncomeTerms;
    const v = formValuesFromTerms(terms, 'asset');
    expect(v.monthlyRent).toBe('1200');
    expect(v.leaseEndDate).toBe('2028-01-31');
    expect(toRequest(v)).toEqual({ incomeType: 'RENT', isDistributing: true, monthlyRent: 1200, leaseEndDate: '2028-01-31', annualIndexationPct: 3 });
  });
});
