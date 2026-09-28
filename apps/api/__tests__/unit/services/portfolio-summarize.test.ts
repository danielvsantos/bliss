/**
 * Unit tests for `summarize()` from `@bliss/shared/portfolio` — the passive
 * income summary the AI insights pipeline puts in the prompt (#80).
 * `packages/shared` has no test runner, so it's tested here against the ESM
 * build, like `project()`.
 */

import { describe, it, expect } from 'vitest';
import { project, summarize, SUMMARY_LIMITS } from '@bliss/shared/portfolio';

const AS_OF = '2026-09-27';

const KO = [
  { exDate: '2026-09-15', amount: 0.53 },
  { exDate: '2026-06-13', amount: 0.51 },
  { exDate: '2026-03-14', amount: 0.51 },
  { exDate: '2025-11-29', amount: 0.51 },
];

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

const fixture = () => ({
  asOf: AS_OF,
  horizon: 12,
  assets: [
    asset({ id: 1, label: 'KO', symbol: 'KO', recentDividends: KO }),
    asset({ id: 2, label: 'VWCE', symbol: 'VWCE', assetClass: 'ETF', quantity: 10, recentDividends: [] }),
    asset({
      id: 3, label: 'Treasury 2027', assetClass: 'BOND', quantity: 10,
      terms: { incomeType: 'FIXED_COUPON', faceValuePerUnit: 1000, couponRate: 6, frequency: 'MONTHLY', maturityDate: '2027-03-15' },
    }),
    asset({
      id: 4, label: 'Floater', assetClass: 'BOND', quantity: 5,
      terms: { incomeType: 'FLOATING_COUPON', faceValuePerUnit: 1000, assumedIndexRate: 4, spread: 1, frequency: 'QUARTERLY', maturityDate: '2031-01-01' },
    }),
    asset({ id: 5, label: 'Flat', assetClass: 'REAL_ESTATE', quantity: 1, currentValue: 300000, terms: { incomeType: 'RENT', monthlyRent: 1200 } }),
    asset({ id: 6, label: 'MSFT', symbol: 'MSFT', recentDividends: null }),
  ],
  streams: [
    { id: 9, name: 'Allowance', fxRate: 1, terms: { incomeType: 'FIXED_AMOUNT', amountPerPayment: 100, frequency: 'MONTHLY', startDate: '2026-01-05' } },
  ],
});

const actuals = Array.from({ length: 12 }, (_, i) => ({ month: `m${i}`, total: 1000.4 }));

describe('summarize()', () => {
  const projection = project(fixture());
  const s = summarize(projection, actuals, 40000);

  it('splits the next 12 months into investment and other, rounded to whole units', () => {
    expect(s.next12m.total).toBe(Math.round(projection.totals.next12mIncome));
    expect(s.next12m.other).toBe(1200);
    expect(s.next12m.investment).toBe(s.next12m.total - s.next12m.other);
    for (const v of Object.values(s.next12m.bySource)) expect(Number.isInteger(v)).toBe(true);
    expect(s.next12m.bySource.rent).toBe(14400);
    expect(s.next12m.bySource.other).toBe(1200);
  });

  it('sums the trailing actuals and computes essential-spending coverage to 1 decimal', () => {
    expect(s.trailing12mActual).toBe(12005);
    expect(s.trailing12mEssentials).toBe(40000);
    expect(s.essentialsCoveragePct).toBe(Math.round((projection.totals.next12mIncome / 40000) * 1000) / 10);
    expect(s.essentialsCoverageInvestmentPct).toBeLessThan(s.essentialsCoveragePct);
  });

  it('accepts the actuals as a plain sum', () => {
    expect(summarize(projection, 5000.6, 40000).trailing12mActual).toBe(5001);
  });

  it('returns null coverage percentages without essential spending', () => {
    const r = summarize(projection, [], 0);
    expect(r.essentialsCoveragePct).toBeNull();
    expect(r.essentialsCoverageInvestmentPct).toBeNull();
    expect(r.trailing12mEssentials).toBeNull();
  });

  it('bounds the top contributors and reports the largest share', () => {
    expect(s.topContributors.length).toBeLessThanOrEqual(SUMMARY_LIMITS.topContributors);
    expect(s.topContributors[0]).toEqual({ label: 'Flat', kind: 'ASSET', next12m: 14400, sharePct: expect.any(Number) });
    expect(s.largestSharePct).toBe(s.topContributors[0].sharePct);
    // Sorted descending
    const values = s.topContributors.map((c) => c.next12m);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  it('flags income that ends within 12 months with its run-rate share', () => {
    expect(s.endingWithin12m.items).toEqual([{ label: 'Treasury 2027', endDate: '2027-03-15', reason: 'MATURITY' }]);
    // 10 × 1000 × 6% / 12 = 50 a month
    expect(s.endingWithin12m.monthlyAmountLost).toBe(50);
    expect(s.endingWithin12m.sharePct).toBe(Math.round(((50 * 12) / projection.totals.next12mIncome) * 1000) / 10);
  });

  it('reports coverage with the missing holdings (bounded, sorted)', () => {
    expect(s.coverage.total).toBe(projection.totals.coverage.total);
    expect(s.coverage.configured).toBe(projection.totals.coverage.configured);
    expect(s.coverage.missingLabels).toEqual(['MSFT']);
    expect(s.coverage.pct).toBe(Math.round((s.coverage.configured / s.coverage.total) * 1000) / 10);
  });

  it('lists income that relies on assumed rates', () => {
    expect(s.assumedRates).toEqual({ count: 1, labels: ['Floater'] });
  });

  it('counts streams and sums stock + ETF dividends only', () => {
    expect(s.streamCount).toBe(1);
    const ko = projection.items.find((i: any) => i.label === 'KO');
    expect(s.dividendsNext12m).toBe(Math.round(ko.next12mTotal));
  });

  it('counts the same symbol held in two accounts as one contributor (#83 grouping)', () => {
    const r = summarize(project({
      asOf: AS_OF,
      horizon: 12,
      assets: [
        asset({ id: 1, label: 'KO · A', symbol: 'KO', securityName: 'Coca-Cola', accountName: 'A', recentDividends: KO }),
        asset({ id: 2, label: 'KO · B', symbol: 'KO', securityName: 'Coca-Cola', accountName: 'B', recentDividends: KO }),
        asset({ id: 3, label: 'PEP', symbol: 'PEP', recentDividends: KO.map((d) => ({ ...d, amount: d.amount * 1.5 })) }),
      ],
    }), [], null);
    expect(r.topContributors.map((c: any) => c.label)).toEqual(['Coca-Cola', 'PEP']);
    expect(r.largestSharePct).toBe(57.1);
    expect(r.coverage.total).toBe(2);
  });

  it('caps missing labels and ending items', () => {
    const many = {
      asOf: AS_OF,
      horizon: 12,
      assets: Array.from({ length: 8 }, (_, i) => [
        asset({ id: 100 + i, label: `S${i}`, symbol: `S${i}` }),
        asset({
          id: 200 + i, label: `B${i}`, assetClass: 'BOND',
          terms: { incomeType: 'FIXED_COUPON', faceValuePerUnit: 100, couponRate: 5, frequency: 'MONTHLY', maturityDate: `2027-0${(i % 8) + 1}-10` },
        }),
      ]).flat(),
    };
    const r = summarize(project(many), [], null);
    expect(r.coverage.missingLabels).toHaveLength(SUMMARY_LIMITS.missingLabels);
    expect(r.endingWithin12m.items).toHaveLength(SUMMARY_LIMITS.endingItems);
    // Sorted by end date
    const dates = r.endingWithin12m.items.map((i: any) => i.endDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it('is deterministic for the same input (stable hash)', () => {
    expect(JSON.stringify(summarize(project(fixture()), actuals, 40000))).toBe(JSON.stringify(s));
  });

  it('handles an empty projection', () => {
    const r = summarize(project({ asOf: AS_OF }), [], null);
    expect(r.next12m.total).toBe(0);
    expect(r.largestSharePct).toBeNull();
    expect(r.endingWithin12m.sharePct).toBeNull();
    expect(r.coverage.pct).toBeNull();
    expect(r.topContributors).toEqual([]);
    expect(summarize(undefined as any).next12m.total).toBe(0);
  });
});
