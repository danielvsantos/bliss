import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EXPENSE_TYPES,
  EXPENSE_INCLUDE_CREDITS_KEY,
  aggregateExpenseGroups,
  aggregateExpenseGroupsByMonth,
  buildExpenseBreakdown,
  expenseValue,
  readIncludeCredits,
  writeIncludeCredits,
} from './expense-breakdown';
import { processAnalyticsIntoFinancialStatement } from './financial-summary';
import type { AnalyticsResponse } from '@/types/api';

const cell = (debit: number, credit = 0) => ({ debit, credit, balance: credit - debit });

// Housing 2026: €16,328 of rent debits, €6,803 credited back by a flatmate.
const housingYear = (() => {
  const data: Record<string, Record<string, Record<string, ReturnType<typeof cell>>>> = {};
  const debits = [1361, 1361, 1361, 1361, 1361, 1361, 1361, 1361, 1361, 1361, 1361, 1357];
  const credits = [567, 567, 567, 567, 567, 567, 567, 567, 567, 567, 567, 566];
  debits.forEach((d, i) => {
    data[`2026-${String(i + 1).padStart(2, '0')}`] = { Essentials: { Housing: cell(d, credits[i]) } };
  });
  return data;
})();

const opts = { maxSlices: 5, otherLabel: 'Other' };

describe('expenseValue', () => {
  it('nets debit − credit by default and ignores credit for the debit basis', () => {
    expect(expenseValue(cell(100, 30), 'net')).toBe(70);
    expect(expenseValue(cell(100, 30), 'debit')).toBe(100);
  });

  it('treats missing cells and fields as 0', () => {
    expect(expenseValue(undefined, 'net')).toBe(0);
    expect(expenseValue({ credit: 40 }, 'net')).toBe(-40);
    expect(expenseValue({ debit: null, credit: null }, 'debit')).toBe(0);
  });
});

describe('aggregateExpenseGroups', () => {
  it('shows Housing net of credits (16,328 − 6,803 = 9,525)', () => {
    expect(aggregateExpenseGroups(housingYear, EXPENSE_TYPES, 'net').Housing).toBeCloseTo(9525, 2);
    expect(aggregateExpenseGroups(housingYear, EXPENSE_TYPES, 'debit').Housing).toBeCloseTo(16328, 2);
  });

  it('nets at group level across the selected types and ignores other types', () => {
    const data = {
      '2026-01': {
        Essentials: { Housing: cell(1000), Health: cell(0, 300) },
        Lifestyle: { Housing: cell(200, 50) },
        Income: { Salary: cell(0, 5000) },
      },
    };
    expect(aggregateExpenseGroups(data, EXPENSE_TYPES, 'net')).toEqual({ Housing: 1150, Health: -300 });
    expect(aggregateExpenseGroups(data, ['Essentials'], 'net')).toEqual({ Housing: 1000, Health: -300 });
  });

  it('returns an empty map for missing data', () => {
    expect(aggregateExpenseGroups(undefined, EXPENSE_TYPES, 'net')).toEqual({});
    expect(aggregateExpenseGroups(null, EXPENSE_TYPES, 'net')).toEqual({});
  });
});

describe('aggregateExpenseGroupsByMonth', () => {
  it('sorts months ascending and keeps negative months signed', () => {
    const data = {
      '2026-02': { Essentials: { Insurance: cell(0, 400) } },
      '2026-01': { Essentials: { Insurance: cell(100) } },
    };
    expect(aggregateExpenseGroupsByMonth(data, EXPENSE_TYPES, 'net')).toEqual([
      { month: '2026-01', groups: { Insurance: 100 } },
      { month: '2026-02', groups: { Insurance: -400 } },
    ]);
  });

  it('monthly Housing points sum to the period total', () => {
    const sum = aggregateExpenseGroupsByMonth(housingYear, EXPENSE_TYPES, 'net')
      .reduce((s, m) => s + (m.groups.Housing ?? 0), 0);
    expect(sum).toBeCloseTo(9525, 2);
  });
});

describe('buildExpenseBreakdown', () => {
  it('a group with Rent +1,000 and an insurance payout −300 is one +700 slice', () => {
    const groups = aggregateExpenseGroups({ '2026-01': { Essentials: { Housing: cell(1000, 300) } } }, EXPENSE_TYPES, 'net');
    const b = buildExpenseBreakdown(groups, opts);
    expect(b.slices).toEqual([{ name: 'Housing', value: 700, percentage: 100, isOther: false }]);
    expect(b.netCredits).toEqual([]);
  });

  it('+600 / +400 / −200 → total 800, pie 60/40, net credits −200', () => {
    const b = buildExpenseBreakdown({ A: 600, B: 400, C: -200 }, opts);
    expect(b.total).toBe(800);
    expect(b.shareTotal).toBe(1000);
    expect(b.slices.map((s) => [s.name, s.percentage])).toEqual([['A', 60], ['B', 40]]);
    expect(b.netCredits).toEqual([{ name: 'C', value: -200 }]);
    expect(b.highest).toEqual({ name: 'A', value: 600 });
    expect(b.allGroups).toEqual(['A', 'B', 'C']);
    for (const s of b.slices) {
      expect(Number.isFinite(s.percentage)).toBe(true);
      expect(s.value).toBeGreaterThan(0);
      expect(s.percentage).toBeLessThanOrEqual(100);
    }
  });

  it('builds "Other" only from positive groups, on the same denominator', () => {
    const groups = { G1: 800, G2: 700, G3: 600, G4: 500, G5: 400, G6: 300, G7: 200, G8: 100, N: -1000 };
    const b = buildExpenseBreakdown(groups, opts);
    expect(b.shareTotal).toBe(3600);
    expect(b.slices).toHaveLength(6);
    const other = b.slices[5];
    expect(other).toEqual({ name: 'Other', value: 600, percentage: 16.7, isOther: true });
    expect(b.slices[0].percentage).toBe(22.2);
    expect(b.total).toBe(2600);
  });

  it('all groups ≤ 0 → no slices, no highest, signed total', () => {
    const b = buildExpenseBreakdown({ A: -50, B: -150, Z: 0 }, opts);
    expect(b.slices).toEqual([]);
    expect(b.highest).toBeNull();
    expect(b.total).toBe(-200);
    expect(b.netCredits).toEqual([{ name: 'B', value: -150 }, { name: 'A', value: -50 }]);
    expect(b.allGroups).toEqual(['A', 'B']);
  });

  it('drops float residue so nothing renders as −0.00 or a hairline slice', () => {
    const b = buildExpenseBreakdown({ A: 0.1 + 0.2 - 0.3, B: -1e-9, C: 10 }, opts);
    expect(b.allGroups).toEqual(['C']);
    expect(b.netCredits).toEqual([]);
    expect(b.slices).toHaveLength(1);
  });

  it('debit basis never produces net credits (toggle off)', () => {
    const data = { '2026-01': { Essentials: { Housing: cell(100, 300) } } };
    const b = buildExpenseBreakdown(aggregateExpenseGroups(data, EXPENSE_TYPES, 'debit'), opts);
    expect(b.netCredits).toEqual([]);
    expect(b.total).toBe(100);
  });

  it('empty input', () => {
    expect(buildExpenseBreakdown({}, opts)).toEqual({
      total: 0, shareTotal: 0, slices: [], netCredits: [], highest: null, allGroups: [],
    });
  });

  it('the net total equals the Financial Summary statement expense total', () => {
    const data = {
      '2026-01': {
        Income: { Salary: cell(0, 5000) },
        Essentials: { Housing: cell(1500, 700), Health: cell(0, 250) },
        Lifestyle: { Dining: cell(320.45, 20.1) },
        Growth: { Courses: cell(99.99) },
      },
      '2026-02': {
        Essentials: { Housing: cell(1500, 700) },
        Lifestyle: { Dining: cell(0, 400) },
      },
    };
    const { statement } = processAnalyticsIntoFinancialStatement(
      { currency: 'EUR', view: 'month', data } as AnalyticsResponse,
      ['2026-01', '2026-02'],
      null,
    );
    const summaryExpense = -statement.types
      .filter((t) => (EXPENSE_TYPES as readonly string[]).includes(t.name))
      .reduce((s, t) => s + Object.values(t.totals).reduce((a, v) => a + v, 0), 0);
    const b = buildExpenseBreakdown(aggregateExpenseGroups(data, EXPENSE_TYPES, 'net'), opts);
    expect(Math.abs(b.total - summaryExpense)).toBeLessThan(0.01);
  });
});

describe('include-credits storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults to on and round-trips off', () => {
    expect(readIncludeCredits()).toBe(true);
    writeIncludeCredits(false);
    expect(window.localStorage.getItem(EXPENSE_INCLUDE_CREDITS_KEY)).toBe('false');
    expect(readIncludeCredits()).toBe(false);
    writeIncludeCredits(true);
    expect(readIncludeCredits()).toBe(true);
  });

  it('falls back to on when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => writeIncludeCredits(false)).not.toThrow();
    expect(readIncludeCredits()).toBe(true);
  });
});
