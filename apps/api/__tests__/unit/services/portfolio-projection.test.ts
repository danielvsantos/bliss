/**
 * Unit tests for the passive income projection engine, `project()` from
 * `@bliss/shared/portfolio` (Passive Income #77). `packages/shared` has no
 * test runner, so the engine is tested here against its ESM build.
 *
 * Dividend fixtures are derived from the Twelve Data spike (R3.1):
 * KO quarterly, O monthly, ITSA4 irregular (monthly JCP + extras), VWCE empty.
 */

import { describe, it, expect } from 'vitest';
import {
  project,
  frequencyFromDividendCount,
  classifyIncomeAsset,
  validateIncomeTerms,
  isStreamEligibleCategory,
  PAYMENT_LAG_DAYS,
} from '@bliss/shared/portfolio';

const AS_OF = '2026-09-27';

const asset = (overrides: any = {}) => ({
  id: 1,
  label: 'Asset',
  assetClass: 'STOCK',
  quantity: 100,
  currentValue: 10000,
  fxRate: 1,
  recentDividends: null,
  terms: null,
  ...overrides,
});

const sumBy = (rows: any[], key: string) => rows.reduce((s, r) => s + r[key], 0);

// Spike-shaped histories (ex-dates within the last 365 days, newest first)
const KO = [
  { exDate: '2026-09-15', amount: 0.53 },
  { exDate: '2026-06-13', amount: 0.51 },
  { exDate: '2026-03-14', amount: 0.51 },
  { exDate: '2025-11-29', amount: 0.51 },
];
const O = Array.from({ length: 12 }, (_, i) => ({
  exDate: `${i < 8 ? 2026 : 2025}-${String(((8 - i + 11) % 12) + 1).padStart(2, '0')}-01`,
  amount: 0.2685,
}));
const ITSA4 = [
  ...Array.from({ length: 12 }, (_, i) => ({
    exDate: `${i < 8 ? 2026 : 2025}-${String(((8 - i + 11) % 12) + 1).padStart(2, '0')}-01`,
    amount: 0.02,
  })),
  { exDate: '2026-03-20', amount: 0.5 },
  { exDate: '2025-12-19', amount: 0.3 },
];

describe('project() — structure', () => {
  it('projects the next N full months after asOf and groups them into years', () => {
    for (const horizon of [12, 24, 36]) {
      const r = project({ assets: [], streams: [], asOf: AS_OF, horizon });
      expect(r.monthly).toHaveLength(horizon);
      expect(r.monthly[0].month).toBe('2026-10');
      expect(r.yearly).toHaveLength(horizon / 12);
      expect(r.window).toEqual({ start: '2026-10-01', end: expect.any(String) });
    }
  });

  it('falls back to 12 months for an unsupported horizon', () => {
    expect(project({ asOf: AS_OF, horizon: 18 }).monthly).toHaveLength(12);
  });

  it('is deterministic for a given asOf', () => {
    const input = { assets: [asset({ recentDividends: KO })], asOf: AS_OF, horizon: 36 };
    expect(project(input)).toEqual(project(input));
  });
});

describe('project() — automatic dividends (12-month replay)', () => {
  it('quarterly payer (KO) → 4 payments a year at ex-date + 14 days', () => {
    const r = project({ assets: [asset({ recentDividends: KO })], asOf: AS_OF, horizon: 36 });
    const year1 = r.monthly.slice(0, 12).filter((m) => m.dividend > 0);
    expect(year1).toHaveLength(4);
    expect(r.totals.next12mIncome).toBeCloseTo((0.53 + 0.51 * 3) * 100, 2);
    expect(r.items[0].frequency).toBe('QUARTERLY');
    expect(r.items[0].source).toBe('AUTO');
    // 2025-11-29 + 1y + 14d = 2026-12-13
    expect(r.items[0].nextPaymentDate).toBe('2026-12-13');
    expect(PAYMENT_LAG_DAYS).toBe(14);
  });

  it('replays across years 2 and 3', () => {
    const r = project({ assets: [asset({ recentDividends: KO })], asOf: AS_OF, horizon: 36 });
    expect(r.yearly.map((y) => Math.round(y.dividend))).toEqual([206, 206, 206]);
  });

  it('monthly payer (O) → 12 payments a year', () => {
    const r = project({ assets: [asset({ recentDividends: O, quantity: 10 })], asOf: AS_OF, horizon: 12 });
    expect(r.monthly.filter((m) => m.dividend > 0)).toHaveLength(12);
    expect(r.items[0].frequency).toBe('MONTHLY');
    expect(r.totals.next12mIncome).toBeCloseTo(12 * 0.2685 * 10, 2);
  });

  it('irregular payer (ITSA4) keeps its pattern including extras', () => {
    const r = project({ assets: [asset({ recentDividends: ITSA4, quantity: 1000 })], asOf: AS_OF, horizon: 12 });
    expect(r.items[0].frequency).toBe('IRREGULAR');
    expect(r.totals.next12mIncome).toBeCloseTo((12 * 0.02 + 0.5 + 0.3) * 1000, 2);
    // The March extra lands in April (ex-date + 14 days) next year.
    const april = r.monthly.find((m) => m.month === '2027-04');
    expect(april!.dividend).toBeGreaterThan(400);
  });

  it('accumulating ETF (VWCE: trusted empty list) → zero, not missing', () => {
    const r = project({ assets: [asset({ assetClass: 'ETF', recentDividends: [] })], asOf: AS_OF });
    expect(r.totals.next12mIncome).toBe(0);
    expect(r.missing).toHaveLength(0);
    expect(r.totals.coverage).toEqual({ configured: 1, total: 1 });
    expect(r.items[0].frequency).toBe('NONE');
  });

  it('untrusted dividends (null) without terms → missing', () => {
    const r = project({ assets: [asset({ hasSecurityData: true })], asOf: AS_OF });
    expect(r.missing).toEqual([expect.objectContaining({ portfolioItemId: 1, reason: 'UNTRUSTED_DIVIDEND' })]);
    expect(r.totals.coverage).toEqual({ configured: 0, total: 1 });
    expect(r.items).toHaveLength(0);
  });

  it('applies the dividend-currency FX rate', () => {
    const r = project({ assets: [asset({ recentDividends: KO, dividendFxRate: 2 })], asOf: AS_OF });
    expect(r.totals.next12mIncome).toBeCloseTo(2 * 206, 2);
  });
});

describe('project() — overrides and non-distributing', () => {
  it('override replaces the replay, spread evenly from the anchor', () => {
    const r = project({
      assets: [asset({
        recentDividends: KO,
        terms: { incomeType: 'DIVIDEND', dividendPerUnit: 4, frequency: 'QUARTERLY', anchorPaymentDate: '2026-10-15' },
      })],
      asOf: AS_OF,
    });
    expect(r.items[0].source).toBe('OVERRIDE');
    expect(r.totals.next12mIncome).toBeCloseTo(400, 2);
    expect(r.monthly.filter((m) => m.dividend > 0).map((m) => m.month)).toEqual(['2026-10', '2027-01', '2027-04', '2027-07']);
  });

  it('override without anchor uses the last ex-date + 14 days, then defaults to quarterly', () => {
    const r = project({
      assets: [asset({ recentDividends: KO, terms: { incomeType: 'DIVIDEND', dividendPerUnit: 4 } })],
      asOf: AS_OF,
    });
    // last ex-date 2026-09-15 + 14 → 2026-09-29, quarterly
    expect(r.items[0].frequency).toBe('QUARTERLY');
    expect(r.items[0].nextPaymentDate).toBe('2026-09-29');
  });

  it('fund override is MANUAL, anchored to month-end when there is no history', () => {
    const r = project({
      assets: [asset({ assetClass: 'FUND', terms: { incomeType: 'DIVIDEND', dividendPerUnit: 1.2, frequency: 'MONTHLY' } })],
      asOf: AS_OF,
    });
    expect(r.items[0].source).toBe('MANUAL');
    expect(r.items[0].nextPaymentDate).toBe('2026-09-30');
    expect(r.totals.next12mIncome).toBeCloseTo(120, 2);
  });

  it("'doesn't distribute' projects zero and is not missing", () => {
    const r = project({
      assets: [asset({ terms: { incomeType: 'DIVIDEND', isDistributing: false } })],
      asOf: AS_OF,
    });
    expect(r.totals.next12mIncome).toBe(0);
    expect(r.missing).toHaveLength(0);
    expect(r.items[0].source).toBe('MANUAL');
  });

  it('DIVIDEND with a yield % and CUSTOM_YIELD both use current value', () => {
    const r = project({
      assets: [
        asset({ id: 1, assetClass: 'FUND', currentValue: 12000, terms: { incomeType: 'DIVIDEND', yieldPct: 5 } }),
        asset({ id: 2, assetClass: 'OTHER', currentValue: 12000, terms: { incomeType: 'CUSTOM_YIELD', yieldPct: 5, frequency: 'QUARTERLY' } }),
      ],
      asOf: AS_OF,
    });
    expect(r.totals.next12mIncome).toBeCloseTo(1200, 2);
    expect(r.items.find((i) => i.portfolioItemId === 1)!.incomeType).toBe('DIVIDEND');
  });

  it('zero or negative quantity produces nothing', () => {
    const r = project({
      assets: [
        asset({ id: 1, quantity: 0, recentDividends: KO }),
        asset({ id: 2, quantity: -5, terms: { incomeType: 'RENT', monthlyRent: 1000 } }),
      ],
      asOf: AS_OF,
    });
    expect(r.totals.next12mIncome).toBe(0);
    expect(r.totals.coverage.total).toBe(0);
  });
});

describe('project() — bonds', () => {
  const bond = (terms: any, overrides: any = {}) => asset({
    assetClass: 'BOND', quantity: 10, currentValue: 10000, terms: { faceValuePerUnit: 1000, ...terms }, ...overrides,
  });

  it('fixed coupon stops at maturity; principal goes to the ladder, not income', () => {
    const r = project({
      assets: [bond({ incomeType: 'FIXED_COUPON', couponRate: 5, frequency: 'SEMIANNUAL', maturityDate: '2027-06-15' })],
      asOf: AS_OF,
      horizon: 36,
    });
    expect(r.totals.next12mIncome).toBeCloseTo(500, 2);
    expect(sumBy(r.yearly, 'coupon')).toBeCloseTo(500, 2);
    expect(r.maturityLadder).toEqual([{ year: 2027, principal: 10000, items: [1] }]);
    expect(r.items[0].endDate).toBe('2027-06-15');
  });

  it('maturity outside the horizon → no ladder entry', () => {
    const r = project({
      assets: [bond({ incomeType: 'FIXED_COUPON', couponRate: 4, frequency: 'ANNUAL', maturityDate: '2035-01-10' })],
      asOf: AS_OF,
      horizon: 12,
    });
    expect(r.maturityLadder).toEqual([]);
    expect(r.totals.next12mIncome).toBeCloseTo(400, 2);
  });

  it('floating rate projects assumed index + spread', () => {
    const r = project({
      assets: [bond({ incomeType: 'FLOATING_COUPON', assumedIndexRate: 10.5, spread: 0.5, frequency: 'ANNUAL', maturityDate: '2030-03-01' })],
      asOf: AS_OF,
    });
    expect(r.items[0].rateOrYield).toBeCloseTo(0.11, 6);
    expect(r.totals.next12mIncome).toBeCloseTo(1100, 2);
  });

  it('inflation-linked projects real coupon + assumed inflation on unadjusted face value', () => {
    const r = project({
      assets: [bond({ incomeType: 'INFLATION_LINKED', couponRate: 6, assumedIndexRate: 4, frequency: 'SEMIANNUAL', maturityDate: '2035-05-15' })],
      asOf: AS_OF,
    });
    expect(r.totals.next12mIncome).toBeCloseTo(1000, 2);
  });

  it('AT_MATURITY pays one accrued amount at maturity', () => {
    const r = project({
      assets: [bond({ incomeType: 'FIXED_COUPON', couponRate: 10, frequency: 'AT_MATURITY', maturityDate: '2027-09-27', anchorPaymentDate: '2026-09-27' })],
      asOf: AS_OF,
      horizon: 24,
    });
    const coupons = r.monthly.filter((m) => m.coupon > 0);
    expect(coupons.map((m) => m.month)).toEqual(['2027-09']);
    expect(coupons[0].coupon).toBeCloseTo(1000, 0);
  });

  it('month-end anchors clamp (Jan 31 → Feb 28, leap Feb 29)', () => {
    const r = project({
      assets: [bond({ incomeType: 'FIXED_COUPON', couponRate: 12, frequency: 'MONTHLY', maturityDate: '2028-12-31', anchorPaymentDate: '2026-01-31' })],
      asOf: AS_OF,
      horizon: 24,
    });
    const events = r.upcomingPayments.map((u) => u.date);
    expect(events).toContain('2027-02-28');
    const all = project({
      assets: [bond({ incomeType: 'FIXED_COUPON', couponRate: 12, frequency: 'MONTHLY', maturityDate: '2028-12-31', anchorPaymentDate: '2026-01-31' })],
      asOf: '2028-01-15',
      horizon: 12,
    });
    expect(all.upcomingPayments.map((u) => u.date)).toContain('2028-02-29');
  });

  it('MATURED_UNREDEEMED status for a bond past maturity that still has quantity', () => {
    const r = project({
      assets: [bond({ incomeType: 'FIXED_COUPON', couponRate: 5, frequency: 'ANNUAL', maturityDate: '2026-01-01' })],
      asOf: AS_OF,
    });
    expect(r.items[0].status).toBe('MATURED_UNREDEEMED');
    expect(r.totals.next12mIncome).toBe(0);
  });

  it('STALE_RATE status for an assumed index rate not updated in 180 days', () => {
    const r = project({
      assets: [bond({ incomeType: 'FLOATING_COUPON', assumedIndexRate: 10, frequency: 'ANNUAL', maturityDate: '2030-01-01', updatedAt: '2026-01-01' })],
      asOf: AS_OF,
    });
    expect(r.items[0].status).toBe('STALE_RATE');
  });
});

describe('project() — rent and cash interest', () => {
  it('net rent monthly, indexed yearly on the start-date anniversary, stops at lease end', () => {
    const r = project({
      assets: [asset({
        assetClass: 'REAL_ESTATE', quantity: 1, currentValue: 300000,
        terms: { incomeType: 'RENT', monthlyRent: 1000, startDate: '2025-03-01', annualIndexationPct: 10, leaseEndDate: '2027-12-31' },
      })],
      asOf: AS_OF,
      horizon: 24,
    });
    const rent = r.monthly.map((m) => m.rent);
    expect(r.monthly[0].rent).toBeCloseTo(1100, 2); // Oct 2026 = 1 anniversary
    expect(r.monthly.find((m) => m.month === '2027-03')!.rent).toBeCloseTo(1210, 2); // 2nd anniversary
    expect(rent.slice(15).every((v) => v === 0)).toBe(true); // after Dec 2027
    expect(r.items[0].endDate).toBe('2027-12-31');
  });

  it('ENDED status for a lease past its end date', () => {
    const r = project({
      assets: [asset({ assetClass: 'REAL_ESTATE', quantity: 1, terms: { incomeType: 'RENT', monthlyRent: 1000, leaseEndDate: '2026-01-01' } })],
      asOf: AS_OF,
    });
    expect(r.items[0].status).toBe('ENDED');
  });

  it('cash APY projects monthly interest on the balance', () => {
    const r = project({
      assets: [asset({ assetClass: 'CASH', quantity: 12000, currentValue: 12000, terms: { incomeType: 'INTEREST', apyPct: 4 } })],
      asOf: AS_OF,
    });
    expect(r.monthly.every((m) => Math.abs(m.interest - 40) < 1e-9)).toBe(true);
    // Cash is not part of the coverage count.
    expect(r.totals.coverage.total).toBe(0);
  });

  it('cash without terms is neither listed nor missing', () => {
    const r = project({ assets: [asset({ assetClass: 'CASH' })], asOf: AS_OF });
    expect(r.items).toHaveLength(0);
    expect(r.missing).toHaveLength(0);
  });
});

describe('project() — streams (allowance & benefits)', () => {
  const stream = (terms: any, overrides: any = {}) => ({ id: 7, name: 'State pension', fxRate: 1, terms: { incomeType: 'FIXED_AMOUNT', ...terms }, ...overrides });

  it('weekly, monthly and annual frequencies', () => {
    const r = project({
      streams: [
        stream({ amountPerPayment: 10, frequency: 'WEEKLY', startDate: '2026-01-02' }, { id: 1 }),
        stream({ amountPerPayment: 100, frequency: 'MONTHLY', startDate: '2026-01-05' }, { id: 2 }),
        stream({ amountPerPayment: 1000, frequency: 'ANNUAL', startDate: '2026-12-20' }, { id: 3 }),
      ],
      asOf: AS_OF,
    });
    const byId = (id: number) => r.items.find((i) => i.streamId === id)!;
    expect(byId(1).next12mTotal).toBeGreaterThanOrEqual(520);
    expect(byId(1).next12mTotal).toBeLessThanOrEqual(530);
    expect(byId(2).next12mTotal).toBe(1200);
    expect(byId(3).next12mTotal).toBe(1000);
  });

  it('stops at the end date and reports ENDED once past it', () => {
    const r = project({ streams: [stream({ amountPerPayment: 100, frequency: 'MONTHLY', startDate: '2026-01-05', endDate: '2027-01-31' })], asOf: AS_OF });
    expect(r.totals.next12mIncome).toBe(400);
    const ended = project({ streams: [stream({ amountPerPayment: 100, frequency: 'MONTHLY', startDate: '2020-01-05', endDate: '2026-01-31' })], asOf: AS_OF });
    expect(ended.items[0].status).toBe('ENDED');
  });

  it('starts at a future start date and indexes on its anniversary', () => {
    const r = project({ streams: [stream({ amountPerPayment: 100, frequency: 'MONTHLY', startDate: '2026-12-10', annualIndexationPct: 3 })], asOf: AS_OF, horizon: 24 });
    expect(r.monthly[0].other).toBe(0);
    expect(r.monthly.find((m) => m.month === '2026-12')!.other).toBe(100);
    expect(r.monthly.find((m) => m.month === '2027-12')!.other).toBeCloseTo(103, 2);
  });

  it('streams count toward total income but not investment income or yield', () => {
    const r = project({
      assets: [asset({ assetClass: 'CASH', quantity: 12000, currentValue: 12000, terms: { incomeType: 'INTEREST', apyPct: 5 } })],
      streams: [stream({ amountPerPayment: 100, frequency: 'MONTHLY', startDate: '2026-01-01' })],
      asOf: AS_OF,
    });
    expect(r.totals.next12mOtherIncome).toBe(1200);
    expect(r.totals.next12mInvestmentIncome).toBeCloseTo(600, 2);
    expect(r.totals.next12mIncome).toBeCloseTo(1800, 2);
    expect(r.totals.yieldOnValue).toBeCloseTo(0.05, 6);
  });

  it('converts with the stream fxRate', () => {
    const r = project({ streams: [stream({ amountPerPayment: 100, frequency: 'MONTHLY', startDate: '2026-01-01' }, { fxRate: 0.5 })], asOf: AS_OF });
    expect(r.totals.next12mIncome).toBe(600);
  });
});

describe('project() — multiple currencies and upcoming payments', () => {
  it('sums items in different currencies via their fxRate and lists the next 10 payments', () => {
    const r = project({
      assets: [
        asset({ id: 1, recentDividends: O, quantity: 10, fxRate: 1 }),
        asset({ id: 2, assetClass: 'BOND', quantity: 1, fxRate: 0.2, terms: { incomeType: 'FIXED_COUPON', faceValuePerUnit: 1000, couponRate: 12, frequency: 'MONTHLY', maturityDate: '2030-01-01', anchorPaymentDate: '2026-01-15' } }),
      ],
      asOf: AS_OF,
    });
    expect(r.totals.next12mIncome).toBeCloseTo(12 * 0.2685 * 10 + 12 * 10 * 0.2, 2);
    expect(r.upcomingPayments).toHaveLength(10);
    const dates = r.upcomingPayments.map((u) => u.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('helpers', () => {
  it('frequencyFromDividendCount', () => {
    expect(frequencyFromDividendCount(0)).toBe('NONE');
    expect(frequencyFromDividendCount(12)).toBe('MONTHLY');
    expect(frequencyFromDividendCount(13)).toBe('MONTHLY');
    expect(frequencyFromDividendCount(4)).toBe('QUARTERLY');
    expect(frequencyFromDividendCount(2)).toBe('SEMIANNUAL');
    expect(frequencyFromDividendCount(1)).toBe('ANNUAL');
    expect(frequencyFromDividendCount(16)).toBe('IRREGULAR');
  });

  it('classifyIncomeAsset', () => {
    expect(classifyIncomeAsset({ type: 'Asset', processingHint: 'CASH' })).toBe('CASH');
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'API_STOCK', group: 'Stocks' })).toBe('STOCK');
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'API_STOCK', securityAssetType: 'ETF' })).toBe('ETF');
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS' })).toBe('ETF');
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'API_FUND', group: 'Funds' })).toBe('FUND');
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'MANUAL', group: 'Bonds' })).toBe('BOND');
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'MANUAL', defaultCategoryCode: 'REAL_ESTATE' })).toBe('REAL_ESTATE');
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'MANUAL', defaultCategoryCode: 'PENSION_PLAN' })).toBe('OTHER');
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'API_CRYPTO' })).toBeNull();
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'API_STOCK', group: 'Commodities' })).toBeNull();
    expect(classifyIncomeAsset({ type: 'Investments', processingHint: 'MANUAL', group: 'Depreciating assets' })).toBeNull();
    expect(classifyIncomeAsset({ type: 'Debt', processingHint: 'AMORTIZING_LOAN' })).toBeNull();
  });

  it('isStreamEligibleCategory', () => {
    const base = { type: 'Income', group: 'Passive Income', processingHint: null, portfolioItemKeyStrategy: 'IGNORE' };
    expect(isStreamEligibleCategory({ ...base, defaultCategoryCode: 'ALLOWANCE' })).toBe(true);
    expect(isStreamEligibleCategory({ ...base, defaultCategoryCode: 'GOVERNMENT_WELFARE' })).toBe(true);
    expect(isStreamEligibleCategory({ ...base, defaultCategoryCode: null })).toBe(true);
    expect(isStreamEligibleCategory({ ...base, defaultCategoryCode: 'DIVIDENDS' })).toBe(false);
    expect(isStreamEligibleCategory({ ...base, group: 'Salary' })).toBe(false);
    expect(isStreamEligibleCategory({ ...base, processingHint: 'RECURRING' })).toBe(false);
    expect(isStreamEligibleCategory(null)).toBe(false);
  });

  it('validateIncomeTerms — required fields for all 9 types', () => {
    const fields = (t: any, mode: any = 'asset') => validateIncomeTerms(t, { mode }).map((e: any) => e.field);
    expect(fields({ incomeType: 'BAD' })).toEqual(['incomeType']);
    expect(fields({ incomeType: 'DIVIDEND' })).toEqual(['dividendPerUnit']);
    expect(fields({ incomeType: 'DIVIDEND', isDistributing: false })).toEqual([]);
    expect(fields({ incomeType: 'FIXED_COUPON' })).toEqual(['faceValuePerUnit', 'couponRate', 'frequency', 'maturityDate']);
    expect(fields({ incomeType: 'FLOATING_COUPON' })).toEqual(['faceValuePerUnit', 'assumedIndexRate', 'frequency', 'maturityDate']);
    expect(fields({ incomeType: 'INFLATION_LINKED' })).toEqual(['faceValuePerUnit', 'couponRate', 'assumedIndexRate', 'frequency', 'maturityDate']);
    expect(fields({ incomeType: 'RENT' })).toEqual(['monthlyRent']);
    expect(fields({ incomeType: 'INTEREST' })).toEqual(['apyPct']);
    expect(fields({ incomeType: 'CUSTOM_YIELD' })).toEqual(['yieldPct']);
    expect(fields({ incomeType: 'NONE' })).toEqual([]);
    expect(fields({ incomeType: 'FIXED_AMOUNT' }, 'stream')).toEqual(['name', 'amountPerPayment', 'frequency', 'currency', 'startDate']);
    expect(fields({ incomeType: 'FIXED_AMOUNT', name: 'x', amountPerPayment: 1, frequency: 'MONTHLY', currency: 'USD', startDate: '2026-01-01' })).toEqual(['incomeType']);
    expect(fields({ incomeType: 'RENT', monthlyRent: 1 }, 'stream')).toEqual(['incomeType']);
  });

  it('validateIncomeTerms — value checks', () => {
    const fields = (t: any) => validateIncomeTerms(t).map((e: any) => e.field);
    expect(fields({ incomeType: 'RENT', monthlyRent: -1 })).toEqual(['monthlyRent']);
    expect(fields({ incomeType: 'RENT', monthlyRent: 'abc' })).toEqual(['monthlyRent']);
    expect(fields({ incomeType: 'INTEREST', apyPct: 20000 })).toEqual(['apyPct']);
    expect(fields({ incomeType: 'RENT', monthlyRent: 1, frequency: 'AT_MATURITY' })).toEqual(['frequency']);
    expect(fields({ incomeType: 'RENT', monthlyRent: 1, startDate: '2026-05-01', endDate: '2026-01-01' })).toEqual(['endDate']);
    expect(fields({ incomeType: 'RENT', monthlyRent: 1, currency: 'usd' })).toEqual(['currency']);
    expect(fields({ incomeType: 'FLOATING_COUPON', faceValuePerUnit: 1, assumedIndexRate: 10, frequency: 'ANNUAL', maturityDate: 'nope', referenceIndex: 'LIBOR' }))
      .toEqual(['referenceIndex', 'maturityDate']);
    expect(validateIncomeTerms(null)).toHaveLength(1);
  });
});
