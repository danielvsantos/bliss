import { describe, it, expect } from 'vitest';
import {
  calculateDiscretionaryIncome,
  calculateSavingsCapacity,
  calculateNetSavings,
  calculatePercentage,
  formatPercentage,
  isCalculatedSection,
  isTypeSection,
  isSeparatorSection,
  FINANCIAL_STRUCTURE,
  processAnalyticsIntoFinancialStatement,
} from './financial-summary';
import type { FinancialStatement } from './financial-summary';

function makeStatement(overrides: Record<string, number> = {}): FinancialStatement {
  const defaults: Record<string, number> = {
    Income: 10000,
    Essentials: -4000,
    Lifestyle: -2000,
    Growth: -1000,
    ...overrides,
  };

  return {
    types: Object.entries(defaults).map(([name, total]) => ({
      name,
      totals: { '2025': total },
      categories: [],
    })),
    netIncome: {},
    netSavings: {},
    savingsPercentage: {},
  };
}

describe('calculateDiscretionaryIncome', () => {
  it('returns Income + Essentials (Essentials is negative)', () => {
    const stmt = makeStatement({ Income: 10000, Essentials: -4000 });
    expect(calculateDiscretionaryIncome(stmt, '2025')).toBe(6000);
  });

  it('returns 0 when types are missing', () => {
    const empty: FinancialStatement = {
      types: [],
      netIncome: {},
      netSavings: {},
      savingsPercentage: {},
    };
    expect(calculateDiscretionaryIncome(empty, '2025')).toBe(0);
  });
});

describe('calculateSavingsCapacity', () => {
  it('returns Discretionary Income + Lifestyle (Lifestyle is negative)', () => {
    const stmt = makeStatement();
    // Discretionary = 10000 + (-4000) = 6000; Savings Capacity = 6000 + (-2000) = 4000
    expect(calculateSavingsCapacity(stmt, '2025')).toBe(4000);
  });

  it('handles missing Lifestyle gracefully', () => {
    const stmt: FinancialStatement = {
      types: [
        { name: 'Income', totals: { '2025': 5000 }, categories: [] },
        { name: 'Essentials', totals: { '2025': -1000 }, categories: [] },
      ],
      netIncome: {},
      netSavings: {},
      savingsPercentage: {},
    };
    // No Lifestyle type, so just discretionaryIncome = 4000
    expect(calculateSavingsCapacity(stmt, '2025')).toBe(4000);
  });
});

describe('calculateNetSavings', () => {
  it('returns Savings Capacity + Growth (Growth is negative)', () => {
    const stmt = makeStatement();
    // Savings Capacity = 4000; Net Savings = 4000 + (-1000) = 3000
    expect(calculateNetSavings(stmt, '2025')).toBe(3000);
  });

  it('handles missing Growth gracefully', () => {
    const stmt: FinancialStatement = {
      types: [
        { name: 'Income', totals: { '2025': 5000 }, categories: [] },
        { name: 'Essentials', totals: { '2025': -2000 }, categories: [] },
        { name: 'Lifestyle', totals: { '2025': -1000 }, categories: [] },
      ],
      netIncome: {},
      netSavings: {},
      savingsPercentage: {},
    };
    // Savings Capacity = 2000; Growth missing = 0; Net Savings = 2000
    expect(calculateNetSavings(stmt, '2025')).toBe(2000);
  });
});

describe('calculatePercentage', () => {
  it('returns 0 when total is 0', () => {
    expect(calculatePercentage(500, 0)).toBe(0);
  });

  it('returns correct percentage', () => {
    expect(calculatePercentage(25, 100)).toBe(25);
    expect(calculatePercentage(1, 3)).toBeCloseTo(33.333, 2);
  });
});

describe('formatPercentage', () => {
  it('adds + for positive values', () => {
    expect(formatPercentage(42)).toBe('+42%');
  });

  it('adds - for negative values', () => {
    expect(formatPercentage(-15)).toBe('-15%');
  });

  it('adds + for zero', () => {
    expect(formatPercentage(0)).toBe('+0%');
  });
});

describe('type guards', () => {
  it('isCalculatedSection returns true for calculated sections', () => {
    expect(isCalculatedSection(FINANCIAL_STRUCTURE.DISCRETIONARY_INCOME)).toBe(true);
    expect(isCalculatedSection(FINANCIAL_STRUCTURE.SAVINGS_CAPACITY)).toBe(true);
    expect(isCalculatedSection(FINANCIAL_STRUCTURE.NET_SAVINGS)).toBe(true);
  });

  it('isCalculatedSection returns false for type sections', () => {
    expect(isCalculatedSection(FINANCIAL_STRUCTURE.INCOME)).toBe(false);
    expect(isCalculatedSection(FINANCIAL_STRUCTURE.ESSENTIALS)).toBe(false);
  });

  it('isTypeSection returns true for type sections', () => {
    expect(isTypeSection(FINANCIAL_STRUCTURE.INCOME)).toBe(true);
    expect(isTypeSection(FINANCIAL_STRUCTURE.LIFESTYLE)).toBe(true);
  });

  it('isTypeSection returns false for calculated sections', () => {
    expect(isTypeSection(FINANCIAL_STRUCTURE.DISCRETIONARY_INCOME)).toBe(false);
  });

  it('isTypeSection returns false for separator sections', () => {
    expect(isTypeSection(FINANCIAL_STRUCTURE.OTHER_ACTIVITY)).toBe(false);
  });

  it('isSeparatorSection returns true for separator sections', () => {
    expect(isSeparatorSection(FINANCIAL_STRUCTURE.OTHER_ACTIVITY)).toBe(true);
  });

  it('isSeparatorSection returns false for other sections', () => {
    expect(isSeparatorSection(FINANCIAL_STRUCTURE.INCOME)).toBe(false);
    expect(isSeparatorSection(FINANCIAL_STRUCTURE.DISCRETIONARY_INCOME)).toBe(false);
  });
});

describe('FINANCIAL_STRUCTURE', () => {
  it('has expected keys', () => {
    const expectedKeys = [
      'INCOME', 'ESSENTIALS', 'DISCRETIONARY_INCOME',
      'LIFESTYLE', 'SAVINGS_CAPACITY', 'GROWTH',
      'NET_SAVINGS', 'OTHER_ACTIVITY', 'VENTURES', 'TRANSFERS',
      'INVESTMENTS', 'DEBT',
    ];
    expect(Object.keys(FINANCIAL_STRUCTURE)).toEqual(expectedKeys);
  });
});

describe('processAnalyticsIntoFinancialStatement', () => {
  it('processes analytics data into statement with correct types', () => {
    const analytics = {
      data: {
        '2025': {
          Income: { Salary: { balance: 5000 } },
          Essentials: { Rent: { balance: -2000 } },
        },
      },
      currency: 'USD',
      timeframe: 'yearly',
    };

    const { statement, monthlyData } = processAnalyticsIntoFinancialStatement(
      analytics,
      ['2025'],
      null,
    );

    expect(statement.types.length).toBeGreaterThan(0);
    const incomeType = statement.types.find(t => t.name === 'Income');
    expect(incomeType).toBeDefined();
    expect(incomeType!.totals['2025']).toBe(5000);

    const essentialsType = statement.types.find(t => t.name === 'Essentials');
    expect(essentialsType).toBeDefined();
    expect(essentialsType!.totals['2025']).toBe(-2000);

    expect(statement.netIncome['2025']).toBe(5000);
    expect(monthlyData).toEqual([]);
  });

  it('returns empty statement on error', () => {
    // Pass invalid data to trigger the catch block
    const { statement, monthlyData } = processAnalyticsIntoFinancialStatement(
      null as unknown as never,
      ['2025'],
      null,
    );

    expect(statement.types).toEqual([]);
    expect(statement.netIncome).toEqual({});
    expect(statement.netSavings).toEqual({});
    expect(monthlyData).toEqual([]);
  });
});
