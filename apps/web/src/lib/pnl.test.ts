import { describe, it, expect } from 'vitest';
import {
  calculateGrossProfit,
  calculateOperatingProfit,
  calculateNetProfit,
  calculatePercentage,
  formatPercentage,
  isCalculatedSection,
  isTypeSection,
  PNL_STRUCTURE,
  processAnalyticsIntoPnL,
} from './pnl';
import type { PnLStatement } from './pnl';

function makeStatement(overrides: Record<string, number> = {}): PnLStatement {
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
    netProfit: {},
    profitPercentage: {},
  };
}

describe('calculateGrossProfit', () => {
  it('returns Income + Essentials (Essentials is negative)', () => {
    const stmt = makeStatement({ Income: 10000, Essentials: -4000 });
    expect(calculateGrossProfit(stmt, '2025')).toBe(6000);
  });

  it('returns 0 when types are missing', () => {
    const empty: PnLStatement = {
      types: [],
      netIncome: {},
      netProfit: {},
      profitPercentage: {},
    };
    expect(calculateGrossProfit(empty, '2025')).toBe(0);
  });
});

describe('calculateOperatingProfit', () => {
  it('returns Gross Profit + Lifestyle (Lifestyle is negative)', () => {
    const stmt = makeStatement();
    // Gross = 10000 + (-4000) = 6000; Operating = 6000 + (-2000) = 4000
    expect(calculateOperatingProfit(stmt, '2025')).toBe(4000);
  });

  it('handles missing Lifestyle gracefully', () => {
    const stmt: PnLStatement = {
      types: [
        { name: 'Income', totals: { '2025': 5000 }, categories: [] },
        { name: 'Essentials', totals: { '2025': -1000 }, categories: [] },
      ],
      netIncome: {},
      netProfit: {},
      profitPercentage: {},
    };
    // No Lifestyle type, so just grossProfit = 4000
    expect(calculateOperatingProfit(stmt, '2025')).toBe(4000);
  });
});

describe('calculateNetProfit', () => {
  it('returns Operating Profit + Growth (Growth is negative)', () => {
    const stmt = makeStatement();
    // Operating = 4000; Net = 4000 + (-1000) = 3000
    expect(calculateNetProfit(stmt, '2025')).toBe(3000);
  });

  it('handles missing Growth gracefully', () => {
    const stmt: PnLStatement = {
      types: [
        { name: 'Income', totals: { '2025': 5000 }, categories: [] },
        { name: 'Essentials', totals: { '2025': -2000 }, categories: [] },
        { name: 'Lifestyle', totals: { '2025': -1000 }, categories: [] },
      ],
      netIncome: {},
      netProfit: {},
      profitPercentage: {},
    };
    // Operating = 2000; Growth missing = 0; Net = 2000
    expect(calculateNetProfit(stmt, '2025')).toBe(2000);
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
    expect(isCalculatedSection(PNL_STRUCTURE.GROSS_PROFIT)).toBe(true);
    expect(isCalculatedSection(PNL_STRUCTURE.OPERATING_PROFIT)).toBe(true);
    expect(isCalculatedSection(PNL_STRUCTURE.NET_PROFIT)).toBe(true);
  });

  it('isCalculatedSection returns false for type sections', () => {
    expect(isCalculatedSection(PNL_STRUCTURE.INCOME)).toBe(false);
    expect(isCalculatedSection(PNL_STRUCTURE.ESSENTIALS)).toBe(false);
  });

  it('isTypeSection returns true for type sections', () => {
    expect(isTypeSection(PNL_STRUCTURE.INCOME)).toBe(true);
    expect(isTypeSection(PNL_STRUCTURE.LIFESTYLE)).toBe(true);
  });

  it('isTypeSection returns false for calculated sections', () => {
    expect(isTypeSection(PNL_STRUCTURE.GROSS_PROFIT)).toBe(false);
  });
});

describe('PNL_STRUCTURE', () => {
  it('has expected keys', () => {
    const expectedKeys = [
      'INCOME', 'ESSENTIALS', 'GROSS_PROFIT',
      'LIFESTYLE', 'OPERATING_PROFIT', 'GROWTH',
      'NET_PROFIT', 'VENTURES', 'TRANSFERS',
      'INVESTMENTS', 'DEBT',
    ];
    expect(Object.keys(PNL_STRUCTURE)).toEqual(expectedKeys);
  });
});

describe('processAnalyticsIntoPnL', () => {
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

    const { statement, monthlyData } = processAnalyticsIntoPnL(
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
    const { statement, monthlyData } = processAnalyticsIntoPnL(
      null as unknown as never,
      ['2025'],
      null,
    );

    expect(statement.types).toEqual([]);
    expect(statement.netIncome).toEqual({});
    expect(statement.netProfit).toEqual({});
    expect(monthlyData).toEqual([]);
  });
});
