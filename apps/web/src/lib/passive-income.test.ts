import { describe, it, expect, vi } from 'vitest';
import {
  BREAKDOWN_VIEW_KEY,
  canHoldIncomeTerms,
  classifyIncomeCategory,
  nextScheduledDate,
  previewIncome,
  readBreakdownView,
  siblingsDiffer,
  writeBreakdownView,
} from './passive-income';
import type { IncomeTerms, IncomeTermsSibling } from '@/types/passive-income';

const TODAY = new Date(Date.UTC(2026, 8, 27)); // 2026-09-27

describe('classifyIncomeCategory', () => {
  it('mirrors the shared classifier', () => {
    expect(classifyIncomeCategory({ type: 'Asset', processingHint: 'CASH' })).toBe('CASH');
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'API_STOCK', group: 'Stocks' })).toBe('STOCK');
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'API_FUND', group: 'ETFs' })).toBe('ETF');
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'API_FUND', group: 'Funds' })).toBe('FUND');
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'MANUAL', group: 'Bonds' })).toBe('BOND');
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'MANUAL', group: 'Real Estate' })).toBe('REAL_ESTATE');
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'MANUAL', group: 'Pension Plan' })).toBe('OTHER');
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'API_CRYPTO' })).toBeNull();
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'API_STOCK', group: 'Commodities' })).toBeNull();
    expect(classifyIncomeCategory({ type: 'Investments', processingHint: 'MANUAL', group: 'Depreciating assets' })).toBeNull();
    expect(classifyIncomeCategory({ type: 'Debt', processingHint: 'AMORTIZING_LOAN' })).toBeNull();
    expect(classifyIncomeCategory(null)).toBeNull();
  });

  it('canHoldIncomeTerms', () => {
    expect(canHoldIncomeTerms({ type: 'Investments', processingHint: 'API_STOCK' })).toBe(true);
    expect(canHoldIncomeTerms({ type: 'Debt' })).toBe(false);
  });
});

describe('nextScheduledDate', () => {
  it('handles monthly clamping, quarterly and weekly schedules', () => {
    const anchor = new Date(Date.UTC(2026, 0, 31));
    expect(nextScheduledDate(anchor, 'MONTHLY', new Date(Date.UTC(2027, 1, 1)))!.toISOString().slice(0, 10)).toBe('2027-02-28');
    expect(nextScheduledDate(anchor, 'QUARTERLY', TODAY)!.toISOString().slice(0, 10)).toBe('2026-10-31');
    expect(nextScheduledDate(new Date(Date.UTC(2026, 8, 1)), 'WEEKLY', TODAY)!.toISOString().slice(0, 10)).toBe('2026-09-29');
    expect(nextScheduledDate(anchor, 'BOGUS', TODAY)).toBeNull();
  });
});

describe('previewIncome', () => {
  it('bond: annual coupon, next payment phased on maturity, maturity year', () => {
    const p = previewIncome(
      { incomeType: 'FIXED_COUPON', faceValuePerUnit: '1000', couponRate: '5', frequency: 'SEMIANNUAL', maturityDate: '2029-11-15' },
      { quantity: 10, today: TODAY },
    );
    expect(p).toEqual({ annual: 500, nextPayment: '2026-11-15', endDate: '2029-11-15' });
  });

  it('floating and inflation-linked bonds add the assumed index', () => {
    expect(previewIncome({ incomeType: 'FLOATING_COUPON', faceValuePerUnit: 100, assumedIndexRate: 10, spread: 1, frequency: 'ANNUAL', maturityDate: '2030-01-01' }, { quantity: 1, today: TODAY })!.annual).toBeCloseTo(11);
    expect(previewIncome({ incomeType: 'INFLATION_LINKED', faceValuePerUnit: 100, couponRate: 6, assumedIndexRate: 4, frequency: 'ANNUAL', maturityDate: '2030-01-01' }, { quantity: 1, today: TODAY })!.annual).toBeCloseTo(10);
  });

  it('AT_MATURITY pays at maturity', () => {
    expect(previewIncome({ incomeType: 'FIXED_COUPON', faceValuePerUnit: 100, couponRate: 10, frequency: 'AT_MATURITY', maturityDate: '2030-01-01' }, { quantity: 1, today: TODAY })!.nextPayment).toBe('2030-01-01');
  });

  it('rent, interest, yield, dividend and streams', () => {
    expect(previewIncome({ incomeType: 'RENT', monthlyRent: 1000, leaseEndDate: '2028-01-01' }, { today: TODAY })).toEqual({ annual: 12000, nextPayment: '2026-09-30', endDate: '2028-01-01' });
    expect(previewIncome({ incomeType: 'INTEREST', apyPct: 4 }, { currentValue: 10000, today: TODAY })!.annual).toBe(400);
    expect(previewIncome({ incomeType: 'CUSTOM_YIELD', yieldPct: 5 }, { currentValue: 1000, today: TODAY })!.annual).toBe(50);
    expect(previewIncome({ incomeType: 'DIVIDEND', dividendPerUnit: 2 }, { quantity: 50, today: TODAY })!.annual).toBe(100);
    expect(previewIncome({ incomeType: 'DIVIDEND', yieldPct: 3 }, { currentValue: 1000, today: TODAY })!.annual).toBe(30);
    expect(previewIncome({ incomeType: 'FIXED_AMOUNT', amountPerPayment: 100, frequency: 'WEEKLY', startDate: '2026-10-05' }, { today: TODAY })).toEqual({ annual: 5200, nextPayment: '2026-10-05', endDate: null });
  });

  it('returns zero when not distributing, and null when inputs are incomplete', () => {
    expect(previewIncome({ incomeType: 'RENT', isDistributing: false, monthlyRent: 1000 })).toEqual({ annual: 0, nextPayment: null, endDate: null });
    expect(previewIncome({ incomeType: 'RENT' }, { today: TODAY })).toBeNull();
  });

  it('drops the next payment after the end date', () => {
    expect(previewIncome({ incomeType: 'FIXED_AMOUNT', amountPerPayment: 10, frequency: 'MONTHLY', startDate: '2020-01-01', endDate: '2026-01-01' }, { today: TODAY })!.nextPayment).toBeNull();
  });
});

describe('breakdown view persistence (#83)', () => {
  it('defaults to grouped and remembers "flat"', () => {
    window.localStorage.removeItem(BREAKDOWN_VIEW_KEY);
    expect(readBreakdownView()).toBe('grouped');
    writeBreakdownView('flat');
    expect(readBreakdownView()).toBe('flat');
    writeBreakdownView('grouped');
    expect(readBreakdownView()).toBe('grouped');
  });

  it('survives storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x'); });
    expect(readBreakdownView()).toBe('grouped');
    expect(() => writeBreakdownView('flat')).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe('siblingsDiffer (#83)', () => {
  const terms = (over: Partial<IncomeTerms>) => ({ incomeType: 'DIVIDEND', isDistributing: true, ...over }) as IncomeTerms;
  const sib = (assetId: number, over: Partial<IncomeTermsSibling>): IncomeTermsSibling => ({
    assetId, accountName: `A${assetId}`, currency: 'USD', quantity: 1, costBasis: null, terms: null, source: 'AUTO', ...over,
  });

  it('is false for one holding or identical terms (dates compared by day)', () => {
    expect(siblingsDiffer([sib(1, {})])).toBe(false);
    expect(siblingsDiffer([sib(1, {}), sib(2, {})])).toBe(false);
    expect(siblingsDiffer([
      sib(1, { source: 'OVERRIDE', terms: terms({ dividendPerUnit: 3, anchorPaymentDate: '2026-10-01T00:00:00.000Z' }) }),
      sib(2, { source: 'OVERRIDE', terms: terms({ dividendPerUnit: 3, anchorPaymentDate: '2026-10-01' }) }),
    ])).toBe(false);
  });

  it('is true when the source or a term differs', () => {
    expect(siblingsDiffer([sib(1, {}), sib(2, { source: 'MISSING' })])).toBe(true);
    expect(siblingsDiffer([
      sib(1, { source: 'OVERRIDE', terms: terms({ dividendPerUnit: 3 }) }),
      sib(2, { source: 'OVERRIDE', terms: terms({ dividendPerUnit: 2 }) }),
    ])).toBe(true);
  });
});
