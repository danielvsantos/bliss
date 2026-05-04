// ─── dataCompletenessServiceHelpers.test.js ──────────────────────────────────
// Tests for the pure helper functions exported from dataCompletenessService.
// These functions have no DB dependency.

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

// Minimal prisma mock — pure helpers don't use it but the module requires it at load
jest.mock('../../../../prisma/prisma.js', () => ({
  analyticsCacheMonthly: { findMany: jest.fn().mockResolvedValue([]) },
  transaction: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  portfolioItem: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  securityMaster: { count: jest.fn().mockResolvedValue(0) },
  portfolioValueHistory: { groupBy: jest.fn().mockResolvedValue([]) },
}));

const {
  countWeekdays,
  getQuarterMonths,
  getQuarterFromMonth,
  getPeriodKey,
  getPreviousPeriod,
  getYoYPeriod,
} = require('../../../services/dataCompletenessService');

describe('dataCompletenessService — pure helpers', () => {
  // ─── countWeekdays ──────────────────────────────────────────────────────────

  describe('countWeekdays()', () => {
    it('counts weekdays in a week with 5 work days', () => {
      // Jan 6-12, 2026 is Mon-Sun
      const start = new Date('2026-01-06');
      const end   = new Date('2026-01-12');
      expect(countWeekdays(start, end)).toBe(5);
    });

    it('returns 0 for a weekend range (Sat-Sun only)', () => {
      const start = new Date('2026-01-10'); // Saturday
      const end   = new Date('2026-01-11'); // Sunday
      expect(countWeekdays(start, end)).toBe(0);
    });

    it('counts weekdays in a full month (January 2026 = 22 weekdays)', () => {
      const start = new Date('2026-01-01');
      const end   = new Date('2026-01-31');
      expect(countWeekdays(start, end)).toBe(22);
    });

    it('returns 1 for a single weekday', () => {
      const start = new Date('2026-01-05'); // Monday
      const end   = new Date('2026-01-05');
      expect(countWeekdays(start, end)).toBe(1);
    });

    it('returns 0 for a single weekend day', () => {
      const start = new Date('2026-01-04'); // Sunday
      const end   = new Date('2026-01-04');
      expect(countWeekdays(start, end)).toBe(0);
    });
  });

  // ─── getQuarterMonths ───────────────────────────────────────────────────────

  describe('getQuarterMonths()', () => {
    it('Q1 → months [1, 2, 3]', () => {
      expect(getQuarterMonths(1)).toEqual([1, 2, 3]);
    });

    it('Q2 → months [4, 5, 6]', () => {
      expect(getQuarterMonths(2)).toEqual([4, 5, 6]);
    });

    it('Q3 → months [7, 8, 9]', () => {
      expect(getQuarterMonths(3)).toEqual([7, 8, 9]);
    });

    it('Q4 → months [10, 11, 12]', () => {
      expect(getQuarterMonths(4)).toEqual([10, 11, 12]);
    });
  });

  // ─── getQuarterFromMonth ────────────────────────────────────────────────────

  describe('getQuarterFromMonth()', () => {
    it('months 1-3 → Q1', () => {
      expect(getQuarterFromMonth(1)).toBe(1);
      expect(getQuarterFromMonth(2)).toBe(1);
      expect(getQuarterFromMonth(3)).toBe(1);
    });

    it('months 4-6 → Q2', () => {
      expect(getQuarterFromMonth(4)).toBe(2);
      expect(getQuarterFromMonth(5)).toBe(2);
      expect(getQuarterFromMonth(6)).toBe(2);
    });

    it('months 7-9 → Q3', () => {
      expect(getQuarterFromMonth(7)).toBe(3);
      expect(getQuarterFromMonth(8)).toBe(3);
      expect(getQuarterFromMonth(9)).toBe(3);
    });

    it('months 10-12 → Q4', () => {
      expect(getQuarterFromMonth(10)).toBe(4);
      expect(getQuarterFromMonth(11)).toBe(4);
      expect(getQuarterFromMonth(12)).toBe(4);
    });
  });

  // ─── getPeriodKey ───────────────────────────────────────────────────────────

  describe('getPeriodKey()', () => {
    it('MONTHLY: formats as YYYY-MM with zero-pad', () => {
      expect(getPeriodKey('MONTHLY', new Date('2026-03-15'))).toBe('2026-03');
      expect(getPeriodKey('MONTHLY', new Date('2026-11-01'))).toBe('2026-11');
    });

    it('QUARTERLY: formats as YYYY-QN', () => {
      expect(getPeriodKey('QUARTERLY', new Date('2026-01-15'))).toBe('2026-Q1');
      expect(getPeriodKey('QUARTERLY', new Date('2026-07-01'))).toBe('2026-Q3');
      expect(getPeriodKey('QUARTERLY', new Date('2026-12-31'))).toBe('2026-Q4');
    });

    it('ANNUAL: formats as YYYY', () => {
      expect(getPeriodKey('ANNUAL', new Date('2026-06-15'))).toBe('2026');
    });

    it('PORTFOLIO: formats as YYYY-WXX', () => {
      const result = getPeriodKey('PORTFOLIO', new Date('2026-01-05'));
      expect(result).toMatch(/^\d{4}-W\d{2}$/);
    });

    it('unknown tier: formats as YYYY-MM-DD', () => {
      const result = getPeriodKey('UNKNOWN', new Date('2026-03-15'));
      expect(result).toBe('2026-03-15');
    });

    it('uses current date when no date is provided', () => {
      const result = getPeriodKey('ANNUAL', null);
      expect(result).toMatch(/^\d{4}$/);
    });
  });

  // ─── getPreviousPeriod ──────────────────────────────────────────────────────

  describe('getPreviousPeriod()', () => {
    it('MONTHLY: returns previous month', () => {
      expect(getPreviousPeriod('MONTHLY', 2026, 3)).toEqual({ year: 2026, month: 2 });
    });

    it('MONTHLY: wraps to December of previous year for January', () => {
      expect(getPreviousPeriod('MONTHLY', 2026, 1)).toEqual({ year: 2025, month: 12 });
    });

    it('QUARTERLY: returns previous quarter', () => {
      expect(getPreviousPeriod('QUARTERLY', 2026, null, 2)).toEqual({ year: 2026, quarter: 1 });
    });

    it('QUARTERLY: wraps to Q4 of previous year for Q1', () => {
      expect(getPreviousPeriod('QUARTERLY', 2026, null, 1)).toEqual({ year: 2025, quarter: 4 });
    });

    it('ANNUAL: returns previous year', () => {
      expect(getPreviousPeriod('ANNUAL', 2026)).toEqual({ year: 2025 });
    });

    it('unknown tier: returns null', () => {
      expect(getPreviousPeriod('UNKNOWN', 2026, 3)).toBeNull();
    });
  });

  // ─── getYoYPeriod ───────────────────────────────────────────────────────────

  describe('getYoYPeriod()', () => {
    it('MONTHLY: returns same month in the previous year', () => {
      expect(getYoYPeriod('MONTHLY', 2026, 6)).toEqual({ year: 2025, month: 6 });
    });

    it('QUARTERLY: returns same quarter in the previous year', () => {
      expect(getYoYPeriod('QUARTERLY', 2026, null, 3)).toEqual({ year: 2025, quarter: 3 });
    });

    it('ANNUAL: returns null (no YoY for annual)', () => {
      expect(getYoYPeriod('ANNUAL', 2026)).toBeNull();
    });

    it('unknown tier: returns null', () => {
      expect(getYoYPeriod('UNKNOWN', 2026, 6)).toBeNull();
    });
  });
});
