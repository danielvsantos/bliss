import { describe, it, expect } from 'vitest';
import { netWorthFromEntry } from './net-worth';
import type { AggregatedPortfolioHistory } from '@/lib/api';

const entry = (e: Partial<AggregatedPortfolioHistory>) =>
  ({ date: '2026-01-01', ...e }) as unknown as AggregatedPortfolioHistory;

describe('netWorthFromEntry', () => {
  it('includes the Cash group in net worth (#144)', () => {
    expect(netWorthFromEntry(entry({
      Asset: { total: 100000, groups: { 'Real Estate': 90000, Cash: 10000 } },
      Investments: { total: 50000, groups: { Stocks: 50000 } },
    } as Partial<AggregatedPortfolioHistory>))).toBe(150000);
  });

  it('subtracts debt whatever its sign', () => {
    const base = { Asset: { total: 20000, groups: { Cash: 20000 } } };
    expect(netWorthFromEntry(entry({ ...base, Debt: { total: -5000, groups: {} } } as Partial<AggregatedPortfolioHistory>))).toBe(15000);
    expect(netWorthFromEntry(entry({ ...base, Debt: { total: 5000, groups: {} } } as Partial<AggregatedPortfolioHistory>))).toBe(15000);
  });

  it('treats missing types as zero', () => {
    expect(netWorthFromEntry(entry({}))).toBe(0);
  });
});
