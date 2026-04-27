// ─── keySignals.test.js ───────────────────────────────────────────────────────
// Unit tests for the pre-computation helper. We're not testing the prose the
// LLM produces — we're testing that the deterministic JS layer correctly
// surfaces deltas, top movers, anomalies, and the savings-rate decomposition
// the model relies on for accurate output.

const { computeKeySignals } = require('../../../../services/insightPrompts/keySignals');

function buildMonthlyData() {
  return {
    tier: 'MONTHLY',
    portfolioCurrency: 'USD',
    targetPeriod: '2026-03',
    comparisonAvailable: { prior: true, yoy: true },
    months: ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'],
    monthlyData: {
      '2026-03': { income: 9200, expenses: 4210, groups: { Dining: 612, Housing: 1800, Transport: 320, Other: 1478 } },
      '2026-02': { income: 9200, expenses: 4260, groups: { Dining: 380, Housing: 1800, Transport: 320, Other: 1760 } },
      '2026-01': { income: 9200, expenses: 4180, groups: { Dining: 350, Housing: 1800, Transport: 310, Other: 1720 } },
      '2025-12': { income: 9200, expenses: 4220, groups: { Dining: 360, Housing: 1800, Transport: 305, Other: 1755 } },
      '2025-11': { income: 9200, expenses: 4150, groups: { Dining: 340, Housing: 1800, Transport: 300, Other: 1710 } },
      '2025-10': { income: 9200, expenses: 4180, groups: { Dining: 360, Housing: 1800, Transport: 310, Other: 1710 } },
      '2025-09': { income: 9100, expenses: 4200, groups: { Dining: 350, Housing: 1800, Transport: 310, Other: 1740 } },
    },
    incomeHistory: [
      { month: '2025-09', income: 9100 },
      { month: '2025-10', income: 9200 },
      { month: '2025-11', income: 9200 },
      { month: '2025-12', income: 9200 },
      { month: '2026-01', income: 9200 },
      { month: '2026-02', income: 9200 },
      { month: '2026-03', income: 9200 },
    ],
    savingsHistory: [
      { month: '2025-09', savings: 4900 },
      { month: '2025-10', savings: 5020 },
      { month: '2025-11', savings: 5050 },
      { month: '2025-12', savings: 4980 },
      { month: '2026-01', savings: 5020 },
      { month: '2026-02', savings: 4940 },
      { month: '2026-03', savings: 4990 },
    ],
    netWorthHistory: [
      { date: '2025-09-01', value: 220000 },
      { date: '2026-03-01', value: 242000 },
    ],
  };
}

describe('computeKeySignals — MONTHLY', () => {
  it('returns the period and comparison availability', () => {
    const signals = computeKeySignals(buildMonthlyData(), 'MONTHLY');
    expect(signals.period).toBe('2026-03');
    expect(signals.comparisonAvailable).toEqual({ prior: true, yoy: true });
  });

  it('computes total spending and MoM delta', () => {
    const { spending } = computeKeySignals(buildMonthlyData(), 'MONTHLY');
    expect(spending.current).toBe(4210);
    expect(spending.prior).toBe(4260);
    expect(spending.momPct).toBeCloseTo(-1.2, 1);
  });

  it('identifies top movers by absolute $ change', () => {
    const { topMovers } = computeKeySignals(buildMonthlyData(), 'MONTHLY');
    // Dining went from 380 → 612 (+232); Other went from 1760 → 1478 (-282).
    // Sorted by abs delta the order should be Other first, then Dining.
    expect(topMovers[0].group).toBe('Other');
    expect(topMovers[0].deltaAbs).toBeCloseTo(-282, 0);
    expect(topMovers[1].group).toBe('Dining');
    expect(topMovers[1].deltaAbs).toBeCloseTo(232, 0);
  });

  it('reports the top category share with a 6-month baseline', () => {
    const { topCategoryShare } = computeKeySignals(buildMonthlyData(), 'MONTHLY');
    // Housing is $1,800 / $4,210 ≈ 42.8% in March; baseline ~ 1800/avg(~4198) ≈ 43%
    expect(topCategoryShare.group).toBe('Housing');
    expect(topCategoryShare.sharePct).toBeGreaterThan(40);
    expect(topCategoryShare.baseline6moSharePct).toBeGreaterThan(40);
  });

  it('computes a savings rate with prior delta', () => {
    const { savingsRate } = computeKeySignals(buildMonthlyData(), 'MONTHLY');
    // (9200 - 4210) / 9200 ≈ 54.2%
    expect(savingsRate.current).toBeCloseTo(54.2, 1);
    // (9200 - 4260) / 9200 ≈ 53.7%
    expect(savingsRate.prior).toBeCloseTo(53.7, 1);
    expect(savingsRate.deltaPP).toBeCloseTo(0.5, 1);
  });

  it('reports income stability with mean, stdev, and CoV', () => {
    const { income } = computeKeySignals(buildMonthlyData(), 'MONTHLY');
    expect(income.arrived).toBe(true);
    expect(income.stability.mean).toBeGreaterThan(9000);
    // Income is nearly constant; CoV should be very low
    expect(income.stability.cov).toBeLessThan(0.05);
  });

  it('derives start/end from the period-anchored breakdown, not the trend window', () => {
    // The trend-window netWorthHistory in buildMonthlyData spans Sept 2025
    // to March 2026 (220k → 242k). The breakdown is period-anchored to
    // Feb-end → Mar-end. Headline start/end must come from the breakdown,
    // so the narrative says "single month" rather than "six months."
    const data = buildMonthlyData();
    data.netWorthBreakdown = [
      { group: 'Stock',       type: 'Investments', start: 80000,   end: 88000,   change: 8000,   changePct: 10 },
      { group: 'Real Estate', type: 'Investments', start: 100000,  end: 110000,  change: 10000,  changePct: 10 },
      { group: 'ETF',         type: 'Investments', start: 40000,   end: 44000,   change: 4000,   changePct: 10 },
    ];
    const { netWorth } = computeKeySignals(data, 'MONTHLY');
    // Sums of breakdown — NOT first/last of netWorthHistory.
    expect(netWorth.start).toBe(220000);
    expect(netWorth.end).toBe(242000);
    expect(netWorth.absolute).toBe(22000);
    expect(netWorth.byAssetType).toHaveLength(3);
    expect(netWorth.byAssetType[0]).toMatchObject({ group: 'Stock', change: 8000 });
  });

  it('falls back to trend-window endpoints when no breakdown is available', () => {
    const data = buildMonthlyData();
    delete data.netWorthBreakdown;
    const { netWorth } = computeKeySignals(data, 'MONTHLY');
    // Without a breakdown we use netWorthHistory's first/last as a
    // best-effort fallback. Less precise (six-month span) but better than
    // null when callers haven't populated the breakdown.
    expect(netWorth.start).toBe(220000);
    expect(netWorth.end).toBe(242000);
    expect(netWorth.byAssetType).toEqual([]);
  });

  it('returns reason when target-month data missing', () => {
    const data = { ...buildMonthlyData(), targetPeriod: '2099-99' };
    const signals = computeKeySignals(data, 'MONTHLY');
    expect(signals.reason).toMatch(/No target-month data/);
  });

  it('handles a single-month tenant (no prior data) gracefully', () => {
    // Tenant onboarded this month — only the target month is in sortedMonths.
    // Comparisons should resolve to null without throwing.
    const data = buildMonthlyData();
    data.months = ['2026-03'];
    data.monthlyData = { '2026-03': data.monthlyData['2026-03'] };
    const signals = computeKeySignals(data, 'MONTHLY');
    expect(signals.spending.prior).toBe(null);
    expect(signals.spending.momPct).toBe(null);
    expect(signals.topMovers).toEqual([]);
  });
});

describe('computeKeySignals — PORTFOLIO', () => {
  it('reports top holdings, top sector, weighted P/E, and weighted dividend yield', () => {
    const portfolioData = {
      tier: 'PORTFOLIO',
      portfolioCurrency: 'USD',
      hasPortfolio: true,
      totalEquityValue: 100000,
      equityHoldings: [
        { symbol: 'AAPL', currentValue: 30000, peRatio: 30, dividendYield: 0.005 },
        { symbol: 'VTI',  currentValue: 50000, peRatio: 21, dividendYield: 0.014 },
        { symbol: 'JNJ',  currentValue: 20000, peRatio: 18, dividendYield: 0.029 },
      ],
      sectorAllocation: {
        Technology: { value: 30000, percent: 30 },
        Diversified: { value: 50000, percent: 50 },
        Healthcare:  { value: 20000, percent: 20 },
      },
    };
    const signals = computeKeySignals(portfolioData, 'PORTFOLIO');
    expect(signals.totalEquity).toBe(100000);
    expect(signals.holdingsCount).toBe(3);
    expect(signals.topHoldings[0].symbol).toBe('VTI');
    expect(signals.topHoldings[0].sharePct).toBe(50);
    expect(signals.topSector.sector).toBe('Diversified');
    // Weighted P/E: 0.3*30 + 0.5*21 + 0.2*18 = 23.1
    expect(signals.weightedPe).toBeCloseTo(23.1, 1);
    // Weighted dividend yield: 0.3*0.5 + 0.5*1.4 + 0.2*2.9 = 1.43%
    expect(signals.weightedDividendYieldPct).toBeCloseTo(1.4, 1);
  });

  it('returns null for weighted metrics when no holding has trusted data', () => {
    const data = {
      equityHoldings: [{ symbol: 'XYZ', currentValue: 1000, peRatio: null, dividendYield: null }],
      totalEquityValue: 1000,
      sectorAllocation: {},
    };
    const signals = computeKeySignals(data, 'PORTFOLIO');
    expect(signals.weightedPe).toBe(null);
    expect(signals.weightedDividendYieldPct).toBe(null);
    expect(signals.trustedHoldingsCount).toBe(0);
    expect(signals.dividendPayingStockValue).toBe(0);
  });

  it('reports top industries with parent sector and constituent symbols', () => {
    const data = {
      equityHoldings: [
        { symbol: 'NVDA', currentValue: 28000, peRatio: 50, dividendYield: 0,    sector: 'Technology', industry: 'Semiconductors' },
        { symbol: 'AMD',  currentValue: 12000, peRatio: 45, dividendYield: 0,    sector: 'Technology', industry: 'Semiconductors' },
        { symbol: 'MSFT', currentValue: 30000, peRatio: 32, dividendYield: 0.008, sector: 'Technology', industry: 'Software' },
        { symbol: 'JNJ',  currentValue: 30000, peRatio: 18, dividendYield: 0.029, sector: 'Healthcare', industry: 'Pharmaceuticals' },
      ],
      totalEquityValue: 100000,
      sectorAllocation: {
        Technology: { value: 70000, percent: 70 },
        Healthcare: { value: 30000, percent: 30 },
      },
      industryAllocation: {
        Semiconductors:  { value: 40000, percent: 40, sector: 'Technology', holdings: ['NVDA', 'AMD'] },
        Software:        { value: 30000, percent: 30, sector: 'Technology', holdings: ['MSFT'] },
        Pharmaceuticals: { value: 30000, percent: 30, sector: 'Healthcare', holdings: ['JNJ'] },
      },
    };
    const signals = computeKeySignals(data, 'PORTFOLIO');
    expect(signals.topIndustries).toHaveLength(3);
    expect(signals.topIndustries[0]).toMatchObject({
      industry: 'Semiconductors',
      sector: 'Technology',
      sharePct: 40,
      holdings: ['NVDA', 'AMD'],
    });
    // Dividend-paying denominator should only include trusted-yield holdings.
    // MSFT (30k) + JNJ (30k) = 60k. NVDA/AMD have zero yield and are excluded.
    expect(signals.dividendPayingStockValue).toBe(60000);
  });

  it('passes through passiveIncomeRecent when present', () => {
    const data = {
      equityHoldings: [{ symbol: 'JNJ', currentValue: 1000, peRatio: 18, dividendYield: 0.029 }],
      totalEquityValue: 1000,
      sectorAllocation: {},
      passiveIncomeRecent: {
        monthsCovered: 3,
        total: 1050,
        monthly: [
          { period: '2026-01', amount: 320 },
          { period: '2026-02', amount: 360 },
          { period: '2026-03', amount: 370 },
        ],
      },
    };
    const signals = computeKeySignals(data, 'PORTFOLIO');
    expect(signals.passiveIncomeRecent.total).toBe(1050);
    expect(signals.passiveIncomeRecent.monthsCovered).toBe(3);
  });
});

describe('computeKeySignals — unknown tier', () => {
  it('returns null', () => {
    expect(computeKeySignals({}, 'UNKNOWN')).toBe(null);
  });
});
