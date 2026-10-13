import { describe, it, expect } from 'vitest';
import {
  getGroupColor,
  buildGroupColorMap,
  getGroupIcon,
  parseDecimal,
  getDisplayData,
  buildPortfolioChartSeries,
} from './portfolio-utils';
import {
  TrendingUp,
  DollarSign,
  HelpCircle,
  Coins,
  Home,
} from 'lucide-react';
import type { PortfolioItem } from '@/types/api';

const DATAVIZ_HEX = [
  '#6D657A', '#2E8B57', '#E09F12', '#3A3542',
  '#3A8A8F', '#B8AEC8', '#7E7590', '#9A95A4',
];

const DEBT_HEX = ['#E5989B', '#D4686C', '#C44E52', '#F0B4B6'];

describe('getGroupColor', () => {
  it('returns dataviz hex for non-debt groups', () => {
    expect(getGroupColor('Stocks', false, 0)).toBe(DATAVIZ_HEX[0]);
    expect(getGroupColor('Cash', false, 3)).toBe(DATAVIZ_HEX[3]);
  });

  it('cycles through dataviz palette with modulo', () => {
    expect(getGroupColor('Extra', false, 8)).toBe(DATAVIZ_HEX[0]);
    expect(getGroupColor('Extra2', false, 10)).toBe(DATAVIZ_HEX[2]);
  });

  it('returns debt hex for debt groups', () => {
    expect(getGroupColor('Mortgage', true, 0)).toBe(DEBT_HEX[0]);
    expect(getGroupColor('Student Loan', true, 2)).toBe(DEBT_HEX[2]);
  });

  it('cycles through debt palette with modulo', () => {
    expect(getGroupColor('Debt5', true, 4)).toBe(DEBT_HEX[0]);
    expect(getGroupColor('Debt6', true, 5)).toBe(DEBT_HEX[1]);
  });
});

describe('buildGroupColorMap', () => {
  it('assigns colors deterministically based on alphabetical sort', () => {
    const map1 = buildGroupColorMap(['Stocks', 'Cash', 'Bonds'], new Set());
    const map2 = buildGroupColorMap(['Cash', 'Bonds', 'Stocks'], new Set());
    expect(map1).toEqual(map2);
    // Alphabetical: Bonds=0, Cash=1, Stocks=2
    expect(map1['Bonds']).toBe(DATAVIZ_HEX[0]);
    expect(map1['Cash']).toBe(DATAVIZ_HEX[1]);
    expect(map1['Stocks']).toBe(DATAVIZ_HEX[2]);
  });

  it('separates debt and non-debt groups correctly', () => {
    const debtGroups = new Set(['Mortgage', 'Credit Card Debt']);
    const allGroups = ['Stocks', 'Cash', 'Mortgage', 'Credit Card Debt'];
    const map = buildGroupColorMap(allGroups, debtGroups);

    // Asset groups get dataviz colors (sorted: Cash=0, Stocks=1)
    expect(map['Cash']).toBe(DATAVIZ_HEX[0]);
    expect(map['Stocks']).toBe(DATAVIZ_HEX[1]);

    // Debt groups get debt colors (sorted: Credit Card Debt=0, Mortgage=1)
    expect(map['Credit Card Debt']).toBe(DEBT_HEX[0]);
    expect(map['Mortgage']).toBe(DEBT_HEX[1]);
  });
});

describe('getGroupIcon', () => {
  it('returns icon for known processingHint (API_STOCK)', () => {
    expect(getGroupIcon('Stocks', 'API_STOCK')).toBe(TrendingUp);
  });

  it('returns icon for known processingHint (API_CRYPTO)', () => {
    expect(getGroupIcon('Crypto', 'API_CRYPTO')).toBe(Coins);
  });

  it('returns icon for known group name (Cash)', () => {
    expect(getGroupIcon('Cash')).toBe(DollarSign);
  });

  it('returns icon for known group name (Real Estate)', () => {
    expect(getGroupIcon('Real Estate')).toBe(Home);
  });

  it('returns HelpCircle for unknown group', () => {
    expect(getGroupIcon('UnknownGroup')).toBe(HelpCircle);
  });

  it('prioritizes processingHint over group name', () => {
    // Group "Cash" would normally give DollarSign, but hint overrides
    expect(getGroupIcon('Cash', 'API_STOCK')).toBe(TrendingUp);
  });
});

describe('parseDecimal', () => {
  it('returns 0 for null', () => {
    expect(parseDecimal(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(parseDecimal(undefined)).toBe(0);
  });

  it('returns the number for number input', () => {
    expect(parseDecimal(42.5)).toBe(42.5);
    expect(parseDecimal(0)).toBe(0);
  });

  it('parses string to float', () => {
    expect(parseDecimal('123.45')).toBe(123.45);
    expect(parseDecimal('0')).toBe(0);
  });

  it('returns 0 for non-numeric string', () => {
    expect(parseDecimal('abc')).toBe(0);
  });

  it('handles object with toString() (Prisma Decimal)', () => {
    const prismaDecimal = { toString: () => '99.99' };
    expect(parseDecimal(prismaDecimal)).toBe(99.99);
  });
});

describe('getDisplayData', () => {
  const usdBlock = { totalValue: 1000, totalGain: 100, totalGainPercent: 10 };
  const portfolioBlock = { totalValue: 900, totalGain: 90, totalGainPercent: 9 };

  const makeItem = (hasPortfolio: boolean) =>
    ({
      usd: usdBlock,
      portfolio: hasPortfolio ? portfolioBlock : undefined,
    }) as unknown as PortfolioItem;

  it('returns portfolio block when currency != USD and portfolio exists', () => {
    const item = makeItem(true);
    expect(getDisplayData(item, 'EUR')).toBe(portfolioBlock);
  });

  it('returns usd block when currency is USD', () => {
    const item = makeItem(true);
    expect(getDisplayData(item, 'USD')).toBe(usdBlock);
  });

  it('returns usd block when currency != USD but no portfolio block', () => {
    const item = makeItem(false);
    expect(getDisplayData(item, 'EUR')).toBe(usdBlock);
  });
});

// ── buildPortfolioChartSeries (#137) ────────────────────────────────────────

describe('buildPortfolioChartSeries', () => {
  const row = (date: string, groups: Record<string, number>, debt?: Record<string, number>) => {
    const total = Object.values(groups).reduce((a, b) => a + b, 0);
    return {
      date,
      totalUSD: total,
      Investments: { total, groups },
      ...(debt && { Debt: { total: Object.values(debt).reduce((a, b) => a + b, 0), groups: debt } }),
    };
  };

  it('returns empty series for no data', () => {
    expect(buildPortfolioChartSeries([], { showDebt: false }).chartData).toEqual([]);
    expect(buildPortfolioChartSeries(undefined, { showDebt: false }).allGroups).toEqual([]);
  });

  it('does not back-date a new holding to the previous sample', () => {
    const { chartData } = buildPortfolioChartSeries([
      row('2025-12-31', { Stocks: 100 }),
      row('2026-01-17', { Stocks: 100 }),
      row('2026-01-20', { Stocks: 100, 'Copy Trading': 500 }),
    ], { showDebt: false });

    // Zero up to the buy day, the value from the buy day — never a ramp before it.
    expect(chartData.map((e) => e['Copy Trading'])).toEqual([0, 0, 500]);
    expect(chartData[2]['Net Worth']).toBe(600);
  });

  it('shows a sold-and-rebought holding as zero only between sell and rebuy', () => {
    const { chartData } = buildPortfolioChartSeries([
      row('2025-07-05', { Crypto: 200, Stocks: 10 }),
      row('2025-07-11', { Crypto: 0, Stocks: 10 }),
      row('2025-08-02', { Stocks: 10 }),
      row('2025-08-29', { Crypto: 150, Stocks: 10 }),
    ], { showDebt: false });

    expect(chartData.map((e) => e.Crypto)).toEqual([200, 0, 0, 150]);
  });

  it('excludes Cash and negates debt when showDebt', () => {
    const { chartData, allGroups, debtGroups } = buildPortfolioChartSeries([
      {
        date: '2026-01-01',
        totalUSD: 0,
        Asset: { total: 1500, groups: { Cash: 500, 'Real Estate': 1000 } },
        Debt: { total: 300, groups: { Mortgage: 300 } },
      },
    ], { showDebt: true });

    expect(allGroups).toEqual(['Real Estate', 'Mortgage']);
    expect(debtGroups.has('Mortgage')).toBe(true);
    expect(chartData[0]).toEqual({ date: '2026-01-01', 'Net Worth': 700, 'Real Estate': 1000, Mortgage: -300 });
  });
});
