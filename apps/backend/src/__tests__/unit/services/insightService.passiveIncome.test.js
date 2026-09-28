/**
 * insightService — passive income & asset class awareness (#80).
 *
 * Covers:
 *   - loadPassiveIncomeInputs(): the backend twin of the API's loadInputs()
 *     (same asset / stream shape, trusted-only dividends, FX via rateCache,
 *     12 complete months of actuals before asOf)
 *   - gatherPassiveIncomeSummary(): project() → summarize(), null without
 *     income sources, never fails the tier run
 *   - gatherEquityFundamentals(): look-through sector allocation, industries
 *     for stocks/REITs only, asset-class mix and fixed income
 *   - gatherPeriodIncomeMix(): passive / investment / other shares
 *   - filterActiveLenses(): PASSIVE_INCOME_OUTLOOK gating
 *   - period anchors + dedup: same period + unchanged data → same hash
 */

jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockTenantFindUnique = jest.fn();
const mockAnalyticsFindMany = jest.fn();
const mockPortfolioItemFindMany = jest.fn();
const mockPortfolioHistoryGroupBy = jest.fn();
const mockSecurityMasterFindMany = jest.fn();
const mockIncomeTermsFindMany = jest.fn();
const mockCategoryFindMany = jest.fn();
const mockTransactionGroupBy = jest.fn();
const mockInsightFindFirst = jest.fn();
const mockInsightFindMany = jest.fn();
const mockInsightCreateMany = jest.fn();
jest.mock('../../../../prisma/prisma.js', () => ({
  tenant: { findUnique: (...a) => mockTenantFindUnique(...a) },
  analyticsCacheMonthly: { findMany: (...a) => mockAnalyticsFindMany(...a) },
  portfolioItem: { findMany: (...a) => mockPortfolioItemFindMany(...a) },
  portfolioValueHistory: { groupBy: (...a) => mockPortfolioHistoryGroupBy(...a) },
  securityMaster: { findMany: (...a) => mockSecurityMasterFindMany(...a) },
  incomeTerms: { findMany: (...a) => mockIncomeTermsFindMany(...a) },
  category: { findMany: (...a) => mockCategoryFindMany(...a) },
  transaction: { groupBy: (...a) => mockTransactionGroupBy(...a) },
  insight: {
    findFirst: (...a) => mockInsightFindFirst(...a),
    findMany: (...a) => mockInsightFindMany(...a),
    createMany: (...a) => mockInsightCreateMany(...a),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
}));

const mockGenerateInsightContent = jest.fn();
jest.mock('../../../services/llm', () => ({
  generateInsightContent: (...a) => mockGenerateInsightContent(...a),
}));

const mockGetRatesForDateRange = jest.fn();
jest.mock('../../../services/currencyService', () => ({
  getRatesForDateRange: (...a) => mockGetRatesForDateRange(...a),
}));

const mockCheckTierCompleteness = jest.fn();
jest.mock('../../../services/dataCompletenessService', () => ({
  checkTierCompleteness: (...a) => mockCheckTierCompleteness(...a),
  getPeriodKey: jest.requireActual('../../../services/dataCompletenessService').getPeriodKey,
  getQuarterMonths: jest.requireActual('../../../services/dataCompletenessService').getQuarterMonths,
  getQuarterFromMonth: jest.requireActual('../../../services/dataCompletenessService').getQuarterFromMonth,
}));

const {
  loadPassiveIncomeInputs,
  gatherPassiveIncomeSummary,
  gatherEquityFundamentals,
  gatherPeriodIncomeMix,
  filterActiveLenses,
  generateTieredInsights,
  portfolioAsOf,
  quarterlyAsOf,
  annualAsOf,
  TIER_LENSES,
  LENS_CATEGORY_MAP,
} = require('../../../services/insightService');
const logger = require('../../../utils/logger');
const shared = require('@bliss/shared/portfolio');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ASOF = new Date(Date.UTC(2026, 8, 21)); // Monday 2026-09-21

const KO_DIVIDENDS = [
  { exDate: '2026-09-15', amount: 0.53 },
  { exDate: '2026-06-13', amount: 0.51 },
  { exDate: '2026-03-14', amount: 0.51 },
  { exDate: '2025-11-29', amount: 0.51 },
];

const STOCK_CAT = { name: 'Stocks', type: 'Investments', group: 'Stocks', processingHint: 'API_STOCK', defaultCategoryCode: 'STOCKS' };
const BOND_CAT = { name: 'Government Bonds', type: 'Investments', group: 'Bonds', processingHint: 'MANUAL', defaultCategoryCode: 'GOVERNMENT_BONDS' };
const CRYPTO_CAT = { name: 'Crypto', type: 'Investments', group: 'Crypto', processingHint: 'API_CRYPTO', defaultCategoryCode: 'CRYPTO' };

/** Portfolio items in the shape loadPassiveIncomeInputs selects. */
function incomeItems() {
  return [
    {
      id: 1, symbol: 'KO', currency: 'USD', assetCurrency: 'USD', quantity: 100,
      currentValue: 7000, currentValueInUSD: 7000,
      category: STOCK_CAT, account: { name: 'Broker' }, incomeTerms: null,
    },
    {
      id: 2, symbol: 'MSFT', currency: 'USD', assetCurrency: 'USD', quantity: 10,
      currentValue: 4000, currentValueInUSD: 4000,
      category: STOCK_CAT, account: null, incomeTerms: null,
    },
    {
      id: 3, symbol: 'Tesouro 2027', currency: 'EUR', assetCurrency: 'EUR', quantity: 10,
      currentValue: 10000, currentValueInUSD: null,
      category: BOND_CAT, account: null,
      incomeTerms: {
        id: 30, incomeType: 'FIXED_COUPON', currency: 'EUR', faceValuePerUnit: 1000, couponRate: 6,
        frequency: 'MONTHLY', maturityDate: '2027-03-15', issuerType: 'GOVERNMENT',
      },
    },
    {
      id: 4, symbol: 'BTC', currency: 'USD', assetCurrency: 'USD', quantity: 1,
      currentValue: 60000, currentValueInUSD: 60000,
      category: CRYPTO_CAT, account: null, incomeTerms: null,
    },
  ];
}

function incomeSecurities() {
  return [
    { symbol: 'KO', assetType: 'Common Stock', currency: 'USD', dividendTrusted: true, recentDividends: KO_DIVIDENDS },
    // Untrusted → not replayed, reported as missing
    { symbol: 'MSFT', assetType: 'Common Stock', currency: 'USD', dividendTrusted: false, recentDividends: [{ exDate: '2026-08-01', amount: 0.83 }] },
  ];
}

const STREAM = {
  id: 90, name: 'Family allowance', currency: 'EUR', categoryId: 7, category: { name: 'Allowance' },
  incomeType: 'FIXED_AMOUNT', amountPerPayment: 100, frequency: 'MONTHLY', startDate: '2026-01-05',
};

/** Rate cache: 1 EUR = 1.1 USD, around the anchor date. */
function eurUsdCache() {
  return { '2026-09-18_EUR_USD': 1.1, '2026-09-21_EUR_USD': 1.1 };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRatesForDateRange.mockResolvedValue(new Map());
  mockInsightFindFirst.mockResolvedValue(null);
  mockInsightFindMany.mockResolvedValue([]);
  mockInsightCreateMany.mockResolvedValue({ count: 0 });
  mockIncomeTermsFindMany.mockResolvedValue([]);
  mockCategoryFindMany.mockResolvedValue([]);
  mockTransactionGroupBy.mockResolvedValue([]);
  mockAnalyticsFindMany.mockResolvedValue([]);
  mockPortfolioHistoryGroupBy.mockResolvedValue([]);
});

// ─── Shared module from CJS ──────────────────────────────────────────────────

describe('@bliss/shared/portfolio (CJS)', () => {
  it('exposes project() and summarize() to the backend', () => {
    expect(typeof shared.project).toBe('function');
    expect(typeof shared.summarize).toBe('function');
    const s = shared.summarize(shared.project({ asOf: '2026-09-21' }), [], null);
    expect(s.next12m.total).toBe(0);
  });
});

// ─── Period anchors ──────────────────────────────────────────────────────────

describe('period anchors', () => {
  it('PORTFOLIO anchors every day of a periodKey week (Sun–Sat) to the same Monday', () => {
    const days = ['2026-09-20', '2026-09-21', '2026-09-23', '2026-09-26'].map((d) => new Date(`${d}T15:00:00Z`));
    const anchors = days.map((d) => portfolioAsOf(d).toISOString().slice(0, 10));
    expect(new Set(anchors)).toEqual(new Set(['2026-09-21']));
    expect(portfolioAsOf(new Date('2026-09-27T01:00:00Z')).toISOString().slice(0, 10)).toBe('2026-09-28');
  });

  it('QUARTERLY / ANNUAL anchor on the first day after the period', () => {
    expect(quarterlyAsOf(2026, 3).toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(quarterlyAsOf(2026, 4).toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(annualAsOf(2025).toISOString().slice(0, 10)).toBe('2026-01-01');
  });
});

// ─── Loader ──────────────────────────────────────────────────────────────────

describe('loadPassiveIncomeInputs()', () => {
  it('builds the same asset / stream shape as the API loadInputs()', async () => {
    mockPortfolioItemFindMany.mockResolvedValue(incomeItems());
    mockSecurityMasterFindMany.mockResolvedValue(incomeSecurities());
    mockIncomeTermsFindMany.mockResolvedValue([STREAM]);

    const inputs = await loadPassiveIncomeInputs('t1', 'USD', eurUsdCache(), ASOF);

    // Crypto is not income-capable → dropped (classifyIncomeAsset → null)
    expect(inputs.assets.map((a) => a.symbol)).toEqual(['KO', 'MSFT', 'Tesouro 2027']);
    const [ko, msft, bond] = inputs.assets;
    expect(ko).toEqual({
      id: 1, label: 'KO · Broker', symbol: 'KO', securityName: null, accountId: null, accountName: 'Broker', currency: 'USD',
      categoryName: 'Stocks', assetClass: 'STOCK',
      quantity: 100, currentValue: 7000, fxRate: 1, dividendFxRate: 1, hasSecurityData: true,
      recentDividends: KO_DIVIDENDS, terms: null,
    });
    // Untrusted dividends are null (not zero)
    expect(msft.recentDividends).toBeNull();
    expect(msft.hasSecurityData).toBe(true);
    // EUR bond: value and terms converted through the rate cache
    expect(bond.assetClass).toBe('BOND');
    expect(bond.fxRate).toBe(1.1);
    expect(bond.currentValue).toBeCloseTo(11000);
    expect(inputs.streams).toEqual([
      { id: 90, name: 'Family allowance', categoryName: 'Allowance', fxRate: 1.1, terms: STREAM },
    ]);
  });

  it('only asks SecurityMaster about API-priced symbols and prefetches missing FX pairs', async () => {
    mockPortfolioItemFindMany.mockResolvedValue(incomeItems());
    mockSecurityMasterFindMany.mockResolvedValue([]);
    mockIncomeTermsFindMany.mockResolvedValue([{ ...STREAM, currency: 'GBP' }]);
    mockGetRatesForDateRange.mockResolvedValue(new Map([['2026-09-21', 1.25]]));

    const rateCache = eurUsdCache();
    const inputs = await loadPassiveIncomeInputs('t1', 'USD', rateCache, ASOF);

    const { where } = mockSecurityMasterFindMany.mock.calls[0][0];
    expect(where.symbol.in.sort()).toEqual(['BTC', 'KO', 'MSFT']);
    // GBP wasn't in the cache → one bulk read; EUR already was → none
    const pairs = mockGetRatesForDateRange.mock.calls.map((c) => `${c[2]}_${c[3]}`);
    expect(pairs).toEqual(['GBP_USD']);
    expect(rateCache['2026-09-21_GBP_USD']).toBe(1.25);
    expect(inputs.streams[0].fxRate).toBe(1.25);
  });

  it('reads 12 complete months before asOf for actuals and essentials', async () => {
    mockPortfolioItemFindMany.mockResolvedValue([]);
    mockAnalyticsFindMany.mockResolvedValue([
      { year: 2026, month: 8, type: 'Income', group: 'Passive Income', balance: 300 },
      { year: 2025, month: 9, type: 'Income', group: 'Passive Income', balance: 200 },
      { year: 2026, month: 8, type: 'Income', group: 'Salary', balance: 9000 },
      { year: 2026, month: 8, type: 'Essentials', group: 'Housing', balance: -1500 },
      { year: 2026, month: 7, type: 'Essentials', group: 'Food', balance: -500 },
    ]);

    const inputs = await loadPassiveIncomeInputs('t1', 'USD', {}, ASOF);

    const { where } = mockAnalyticsFindMany.mock.calls[0][0];
    expect(where.OR).toHaveLength(12);
    expect(where.OR[0]).toEqual({ year: 2025, month: 9 });
    expect(where.OR[11]).toEqual({ year: 2026, month: 8 }); // September (asOf's month) excluded
    expect(inputs.actuals).toHaveLength(12);
    expect(inputs.actuals[0]).toEqual({ month: '2025-09', total: 200 });
    expect(inputs.actuals[11]).toEqual({ month: '2026-08', total: 300 });
    expect(inputs.trailingEssentials).toBe(2000);
  });
});

describe('gatherPassiveIncomeSummary()', () => {
  it('projects and summarizes as of the anchor date', async () => {
    mockPortfolioItemFindMany.mockResolvedValue(incomeItems());
    mockSecurityMasterFindMany.mockResolvedValue(incomeSecurities());
    mockIncomeTermsFindMany.mockResolvedValue([STREAM]);
    mockAnalyticsFindMany.mockResolvedValue([
      { year: 2026, month: 8, type: 'Essentials', group: 'Housing', balance: -12000 },
    ]);

    const s = await gatherPassiveIncomeSummary('t1', 'USD', eurUsdCache(), ASOF);

    expect(s.asOf).toBe('2026-09-21');
    expect(s.streamCount).toBe(1);
    expect(s.next12m.other).toBe(1320); // 12 × 100 EUR × 1.1
    expect(s.coverage).toEqual({ configured: 2, total: 3, pct: 66.7, missingLabels: ['MSFT'] });
    // KO replay: (0.53 + 3 × 0.51) × 100
    expect(s.dividendsNext12m).toBe(206);
    expect(s.endingWithin12m.items).toEqual([
      { label: 'Tesouro 2027', endDate: '2027-03-15', reason: 'MATURITY' },
    ]);
    expect(s.trailing12mEssentials).toBe(12000);
  });

  it('returns null when nothing produces passive income', async () => {
    mockPortfolioItemFindMany.mockResolvedValue([incomeItems()[3]]); // crypto only
    mockSecurityMasterFindMany.mockResolvedValue([]);
    expect(await gatherPassiveIncomeSummary('t1', 'USD', {}, ASOF)).toBeNull();
  });

  it('never fails the tier run — a load error drops the signal with a warning', async () => {
    mockPortfolioItemFindMany.mockRejectedValue(new Error('db down'));
    expect(await gatherPassiveIncomeSummary('t1', 'USD', {}, ASOF)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Passive income summary failed/), expect.any(Object));
  });
});

// ─── Equity look-through ─────────────────────────────────────────────────────

describe('gatherEquityFundamentals() — asset classes & look-through', () => {
  const QQQ_COMPOSITION = {
    sectors: [
      { sector: 'Technology', weight: 0.59 },
      { sector: 'Communication Services', weight: 0.16 },
      { sector: 'Consumer Cyclical', weight: 0.13 },
    ],
    countries: [{ country: 'United States', weight: 0.97 }],
    assetAllocation: { stocks: 0.995, bonds: 0 },
  };

  function portfolio() {
    return [
      { id: 1, symbol: 'NVDA', currency: 'USD', currentValue: 30000, costBasis: 10000, quantity: 100, realizedPnL: 0, category: STOCK_CAT },
      { id: 2, symbol: 'JPM', currency: 'USD', currentValue: 10000, costBasis: 8000, quantity: 50, realizedPnL: 0, category: STOCK_CAT },
      { id: 3, symbol: 'O', currency: 'USD', currentValue: 5000, costBasis: 5000, quantity: 90, realizedPnL: 0, category: STOCK_CAT },
      { id: 4, symbol: 'QQQ', currency: 'USD', currentValue: 50000, costBasis: 40000, quantity: 100, realizedPnL: 0, category: { name: 'ETFs', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS', group: 'ETFs' } },
      { id: 5, symbol: 'VWCE', currency: 'USD', currentValue: 20000, costBasis: 18000, quantity: 150, realizedPnL: 0, category: { name: 'ETFs', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS', group: 'ETFs' } },
      { id: 6, symbol: 'BND', currency: 'USD', currentValue: 15000, costBasis: 15000, quantity: 200, realizedPnL: 0, category: { name: 'ETFs', processingHint: 'API_FUND', defaultCategoryCode: 'ETFS', group: 'ETFs' } },
      {
        id: 7, symbol: 'Tesouro 2035', currency: 'USD', currentValue: 9500, costBasis: 9000, quantity: 10, realizedPnL: 0,
        category: BOND_CAT,
        incomeTerms: { incomeType: 'FIXED_COUPON', issuerType: 'GOVERNMENT', faceValuePerUnit: 1000, couponRate: 6, maturityDate: '2031-09-21', currency: 'USD' },
      },
      {
        id: 8, symbol: 'ACME 2029', currency: 'USD', currentValue: 5000, costBasis: 5000, quantity: 5, realizedPnL: 0,
        category: { name: 'Corporate Bonds', processingHint: 'MANUAL', defaultCategoryCode: 'CORPORATE_BONDS', group: 'Bonds' },
        incomeTerms: { incomeType: 'FIXED_COUPON', faceValuePerUnit: 1000, couponRate: 8, maturityDate: '2029-09-21', currency: 'USD' },
      },
      { id: 9, symbol: 'Flat', currency: 'USD', currentValue: 200000, costBasis: 150000, quantity: 1, realizedPnL: 0, category: { name: 'Real Estate', processingHint: 'MANUAL', defaultCategoryCode: 'REAL_ESTATE', group: 'Real Estate' } },
      { id: 10, symbol: 'BTC', currency: 'USD', currentValue: 60000, costBasis: 20000, quantity: 1, realizedPnL: 0, category: CRYPTO_CAT },
    ];
  }

  function securities() {
    return [
      { symbol: 'NVDA', name: 'NVIDIA', sector: 'Technology', industry: 'Semiconductors', country: 'United States', peRatio: 50, earningsTrusted: true, dividendTrusted: true, dividendYield: 0.0003, assetType: 'Common Stock' },
      { symbol: 'JPM', name: 'JPMorgan', sector: 'Financial Services', industry: 'Banks', country: 'United States', peRatio: 12, earningsTrusted: true, dividendTrusted: true, dividendYield: 0.022, assetType: 'Common Stock' },
      { symbol: 'O', name: 'Realty Income', sector: 'Real Estate', industry: 'REIT - Retail', country: 'United States', peRatio: 55, earningsTrusted: true, dividendTrusted: true, dividendYield: 0.055, assetType: 'REIT' },
      { symbol: 'QQQ', name: 'Invesco QQQ Trust', sector: null, industry: null, country: null, peRatio: 30, earningsTrusted: true, dividendTrusted: true, dividendYield: 0.006, assetType: 'ETF', etfComposition: QQQ_COMPOSITION },
      // No composition → "Diversified", excluded
      { symbol: 'VWCE', name: 'Vanguard FTSE All-World', sector: null, industry: null, country: null, earningsTrusted: false, dividendTrusted: true, dividendYield: 0, assetType: 'ETF', etfComposition: null },
      { symbol: 'BND', name: 'Vanguard Total Bond Market ETF', sector: null, industry: null, country: null, earningsTrusted: false, dividendTrusted: true, dividendYield: 0.035, assetType: 'ETF', etfComposition: { sectors: [], countries: [], assetAllocation: { bonds: 0.99 } } },
    ];
  }

  it('classifies every holding with the shared classifier', async () => {
    mockPortfolioItemFindMany.mockResolvedValue(portfolio());
    mockSecurityMasterFindMany.mockResolvedValue(securities());

    const r = await gatherEquityFundamentals('t1', 'USD', {}, ASOF);

    expect(Object.fromEntries(r.holdings.map((h) => [h.symbol, h.assetClass]))).toEqual({
      NVDA: 'STOCK', JPM: 'STOCK', O: 'REIT', QQQ: 'INDEX_ETF', VWCE: 'INDEX_ETF', BND: 'BOND_ETF',
      'Tesouro 2035': 'GOV_BOND', 'ACME 2029': 'CORP_BOND', Flat: 'REAL_ESTATE', BTC: 'CRYPTO',
    });
    // Composition is requested from SecurityMaster
    expect(mockSecurityMasterFindMany.mock.calls[0][0].select.etfComposition).toBe(true);
  });

  it('builds sector allocation by look-through when ETF composition exists, never flagging non-equities', async () => {
    mockPortfolioItemFindMany.mockResolvedValue(portfolio());
    mockSecurityMasterFindMany.mockResolvedValue(securities());

    const r = await gatherEquityFundamentals('t1', 'USD', {}, ASOF);

    // Base = the equity book: NVDA 30k + JPM 10k + O 5k + QQQ 50k + VWCE 20k = 115k.
    // QQQ's 12% remainder (6k) and uncomposed VWCE (20k) are unclassified.
    expect(r.equityValue).toBe(115000);
    expect(r.unclassifiedEquityValue).toBe(26000);
    const tech = r.sectorAllocation.Technology;
    // NVDA 30k + 59% of QQQ (29.5k)
    expect(tech.value).toBe(59500);
    expect(tech.percent).toBe(51.74);
    expect(tech.holdings).toEqual(['NVDA']);
    expect(tech.viaEtfs).toEqual([{ symbol: 'QQQ', weightPct: 59 }]);
    expect(r.sectorAllocation['Real Estate']).toEqual(expect.objectContaining({ value: 5000, holdings: ['O'] }));
    // Never a bucket for bonds, property, crypto, uncomposed ETFs or remainders
    for (const bucket of ['Diversified', 'Other', 'Unknown', 'Fixed Income', 'Alternative Assets', 'ETFs & Funds', 'Cryptocurrency']) {
      expect(r.sectorAllocation[bucket]).toBeUndefined();
    }
    const pctSum = Object.values(r.sectorAllocation).reduce((s, g) => s + g.percent, 0);
    expect(pctSum).toBeCloseTo(((115000 - 26000) / 115000) * 100, 1);
  });

  // ETF composition is optional (Twelve Data plan-dependent) and usually
  // absent: ETFs must stay in the base, not vanish from it.
  it('without ETF composition, a mostly-ETF portfolio never reads as concentrated', async () => {
    mockPortfolioItemFindMany.mockResolvedValue([
      { id: 1, symbol: 'VWCE', currency: 'USD', currentValue: 90000, costBasis: 80000, quantity: 700, realizedPnL: 0, category: { name: 'ETFs', processingHint: 'API_FUND' } },
      { id: 2, symbol: 'NVDA', currency: 'USD', currentValue: 10000, costBasis: 5000, quantity: 60, realizedPnL: 0, category: STOCK_CAT },
    ]);
    mockSecurityMasterFindMany.mockResolvedValue([
      { symbol: 'VWCE', name: 'Vanguard FTSE All-World', assetType: 'ETF', etfComposition: null, earningsTrusted: false, dividendTrusted: true },
      { symbol: 'NVDA', name: 'NVIDIA', sector: 'Technology', industry: 'Semiconductors', assetType: 'Common Stock', earningsTrusted: true, peRatio: 50 },
    ]);

    const r = await gatherEquityFundamentals('t1', 'USD', {}, ASOF);

    expect(r.holdings.map((h) => h.assetClass)).toEqual(['INDEX_ETF', 'STOCK']);
    expect(r.equityValue).toBe(100000);
    expect(r.unclassifiedEquityValue).toBe(90000);
    expect(Object.keys(r.sectorAllocation)).toEqual(['Technology']);
    expect(r.sectorAllocation.Technology).toEqual(expect.objectContaining({ percent: 10, holdings: ['NVDA'], viaEtfs: [] }));
    expect(r.industryAllocation.Semiconductors.percent).toBe(10);
  });

  it('keeps industries to stocks and REITs, as a share of the equity base', async () => {
    mockPortfolioItemFindMany.mockResolvedValue(portfolio());
    mockSecurityMasterFindMany.mockResolvedValue(securities());

    const r = await gatherEquityFundamentals('t1', 'USD', {}, ASOF);

    expect(Object.keys(r.industryAllocation).sort()).toEqual(['Banks', 'REIT - Retail', 'Semiconductors']);
    expect(r.industryAllocation.Semiconductors).toEqual(
      expect.objectContaining({ value: 30000, sector: 'Technology', holdings: ['NVDA'], percent: 26.09 }),
    );
  });

  it('never gives an ETF a P/E', async () => {
    mockPortfolioItemFindMany.mockResolvedValue(portfolio());
    mockSecurityMasterFindMany.mockResolvedValue(securities());

    const r = await gatherEquityFundamentals('t1', 'USD', {}, ASOF);
    const bySymbol = Object.fromEntries(r.holdings.map((h) => [h.symbol, h]));
    expect(bySymbol.QQQ.peRatio).toBeNull();
    expect(bySymbol.NVDA.peRatio).toBe(50);
  });

  it('reports the asset-class mix and the fixed-income summary', async () => {
    mockPortfolioItemFindMany.mockResolvedValue(portfolio());
    mockSecurityMasterFindMany.mockResolvedValue(securities());

    const r = await gatherEquityFundamentals('t1', 'USD', {}, ASOF);

    expect(r.assetClassAllocation[0]).toEqual({ assetClass: 'REAL_ESTATE', percent: expect.any(Number), count: 1 });
    expect(r.assetClassAllocation.map((a) => a.assetClass)).toEqual(
      expect.arrayContaining(['STOCK', 'INDEX_ETF', 'BOND_ETF', 'REIT', 'GOV_BOND', 'CORP_BOND', 'CRYPTO']),
    );
    expect(r.fixedIncome).toEqual({
      totalFace: 15000,
      weightedCouponPct: 6.67,
      avgYearsToMaturity: expect.any(Number),
      governmentPct: 66.67,
      corporatePct: 33.33,
      count: 2,
    });
    // Anchored on asOf: 5y and 3y out → (5×10000 + 3×5000) / 15000 ≈ 4.33
    expect(r.fixedIncome.avgYearsToMaturity).toBeCloseTo(4.33, 1);
  });
});

// ─── Income mix ──────────────────────────────────────────────────────────────

describe('gatherPeriodIncomeMix()', () => {
  const base = {
    tenantId: 't1',
    portfolioCurrency: 'USD',
    monthKeys: ['2026-07', '2026-08', '2026-09'],
    passiveIncomeByMonth: { '2026-07': 400, '2026-08': 400, '2026-09': 400, '2026-06': 999 },
    totalIncome: 30000,
    periodStart: new Date(Date.UTC(2026, 6, 1)),
    periodEnd: new Date(Date.UTC(2026, 8, 30, 23, 59, 59)),
  };

  it('splits the period\'s passive income into investment and other (stream-category) income', async () => {
    mockCategoryFindMany.mockResolvedValue([
      { id: 1, type: 'Income', group: 'Passive Income', processingHint: null, portfolioItemKeyStrategy: 'IGNORE', defaultCategoryCode: 'ALLOWANCE' },
      { id: 2, type: 'Income', group: 'Passive Income', processingHint: null, portfolioItemKeyStrategy: 'IGNORE', defaultCategoryCode: 'DIVIDENDS' },
    ]);
    mockTransactionGroupBy.mockResolvedValue([
      { currency: 'USD', _sum: { credit: 200, debit: 0 } },
      { currency: 'EUR', _sum: { credit: 100, debit: 0 } },
    ]);

    const mix = await gatherPeriodIncomeMix({ ...base, rateCache: { '2026-09-30_EUR_USD': 1.1 } });

    // Only the stream-eligible category (not DIVIDENDS) is queried
    expect(mockTransactionGroupBy.mock.calls[0][0].where.categoryId).toEqual({ in: [1] });
    expect(mix).toEqual({
      totalIncome: 30000,
      passiveIncome: 1200,
      investmentPassiveIncome: 890,
      otherPassiveIncome: 310,
      passiveIncomeSharePct: 4,
      investmentPassiveIncomeSharePct: 3,
      otherPassiveIncomeSharePct: 1,
    });
  });

  it('skips the transaction read without stream categories, and handles zero income', async () => {
    const mix = await gatherPeriodIncomeMix({ ...base, rateCache: {}, totalIncome: 0 });
    expect(mockTransactionGroupBy).not.toHaveBeenCalled();
    expect(mix.otherPassiveIncome).toBe(0);
    expect(mix.passiveIncomeSharePct).toBeNull();
  });
});

// ─── Lens gating ─────────────────────────────────────────────────────────────

describe('PASSIVE_INCOME_OUTLOOK lens registration', () => {
  it('runs in PORTFOLIO, QUARTERLY and ANNUAL — not MONTHLY — as an INCOME lens', () => {
    expect(TIER_LENSES.PORTFOLIO).toContain('PASSIVE_INCOME_OUTLOOK');
    expect(TIER_LENSES.QUARTERLY).toContain('PASSIVE_INCOME_OUTLOOK');
    expect(TIER_LENSES.ANNUAL).toContain('PASSIVE_INCOME_OUTLOOK');
    expect(TIER_LENSES.MONTHLY).not.toContain('PASSIVE_INCOME_OUTLOOK');
    expect(LENS_CATEGORY_MAP.PASSIVE_INCOME_OUTLOOK).toBe('INCOME');
  });

  const pi = (overrides = {}) => ({ coverage: { total: 0 }, streamCount: 0, next12m: { total: 0 }, ...overrides });

  it.each([
    ['assets only', pi({ coverage: { total: 2 } }), true],
    ['streams only', pi({ streamCount: 1, next12m: { total: 1200 } }), true],
    ['neither', pi(), false],
    ['no summary', null, false],
  ])('filterActiveLenses: %s', (_label, passiveIncome, active) => {
    const lenses = filterActiveLenses('QUARTERLY', { hasTransactions: true, passiveIncome });
    expect(lenses.includes('PASSIVE_INCOME_OUTLOOK')).toBe(active);
  });
});

// ─── Dedup stability ─────────────────────────────────────────────────────────

describe('skip-if-unchanged hash (#80)', () => {
  function seedPortfolioTenant() {
    mockTenantFindUnique.mockResolvedValue({ portfolioCurrency: 'USD' });
    mockPortfolioItemFindMany.mockImplementation(({ select } = {}) => {
      if (select?.incomeTerms === true) return Promise.resolve(incomeItems()); // passive income loader
      return Promise.resolve([
        { id: 1, symbol: 'KO', currency: 'USD', currentValue: 7000, costBasis: 5000, quantity: 100, realizedPnL: 0, category: { ...STOCK_CAT, type: 'Investments' }, debtTerms: null },
      ]);
    });
    mockSecurityMasterFindMany.mockImplementation(({ select }) => {
      if (select.recentDividends) return Promise.resolve(incomeSecurities());
      return Promise.resolve([{ symbol: 'KO', name: 'Coca-Cola', sector: 'Consumer Defensive', industry: 'Beverages', assetType: 'Common Stock' }]);
    });
    mockIncomeTermsFindMany.mockResolvedValue([STREAM]);
    mockCheckTierCompleteness.mockResolvedValue({ canRun: true, comparisonAvailable: true });
    mockGenerateInsightContent.mockResolvedValue([
      { lens: 'PASSIVE_INCOME_OUTLOOK', title: 'T', body: 'B', severity: 'INFO', priority: 50, metadata: {} },
    ]);
  }

  const hashOfRun = () => mockInsightFindFirst.mock.calls
    .map((c) => c[0].where)
    .filter((w) => w.dataHash)
    .map((w) => w.dataHash)
    .pop();

  afterEach(() => jest.useRealTimers());

  it('two PORTFOLIO runs in the same week with unchanged data hash the same', async () => {
    seedPortfolioTenant();
    jest.useFakeTimers({ now: new Date('2026-09-21T05:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    await generateTieredInsights('t1', 'PORTFOLIO');
    const first = hashOfRun();

    jest.setSystemTime(new Date('2026-09-24T18:00:00Z'));
    await generateTieredInsights('t1', 'PORTFOLIO');
    const second = hashOfRun();

    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
    // The prompt carries the engine summary
    const { userMessage } = mockGenerateInsightContent.mock.calls[0][0];
    expect(userMessage).toMatch(/"dividendsNext12m": 206/);
    expect(userMessage).toMatch(/PASSIVE_INCOME_OUTLOOK/);
  });

  it('a change in income terms changes the hash', async () => {
    seedPortfolioTenant();
    jest.useFakeTimers({ now: new Date('2026-09-21T05:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    await generateTieredInsights('t1', 'PORTFOLIO');
    const before = hashOfRun();

    mockIncomeTermsFindMany.mockResolvedValue([{ ...STREAM, amountPerPayment: 150 }]);
    await generateTieredInsights('t1', 'PORTFOLIO');
    expect(hashOfRun()).not.toBe(before);
  });

  it('passes the previous period\'s essential-spending coverage for milestone severity', async () => {
    seedPortfolioTenant();
    jest.useFakeTimers({ now: new Date('2026-09-21T05:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    mockInsightFindFirst.mockImplementation(({ where }) => Promise.resolve(
      where.lens === 'PASSIVE_INCOME_OUTLOOK' ? { metadata: { dataPoints: { current: 23.5 } } } : null,
    ));

    await generateTieredInsights('t1', 'PORTFOLIO');

    const priorQuery = mockInsightFindFirst.mock.calls.map((c) => c[0]).find((q) => q.where.lens);
    expect(priorQuery.where).toEqual({
      tenantId: 't1', tier: 'PORTFOLIO', lens: 'PASSIVE_INCOME_OUTLOOK', periodKey: { lt: expect.any(String) },
    });
    const { userMessage } = mockGenerateInsightContent.mock.calls[0][0];
    expect(userMessage).toMatch(/"priorEssentialsCoveragePct": 23.5/);
  });

  it('QUARTERLY carries passive income and the income mix', async () => {
    seedPortfolioTenant();
    mockAnalyticsFindMany.mockResolvedValue([
      { year: 2026, month: 8, type: 'Income', group: 'Salary', balance: 9000 },
      { year: 2026, month: 8, type: 'Income', group: 'Passive Income', balance: 300 },
      { year: 2026, month: 8, type: 'Essentials', group: 'Housing', balance: -1500 },
    ]);

    await generateTieredInsights('t1', 'QUARTERLY', { year: 2026, quarter: 3 });

    const { userMessage } = mockGenerateInsightContent.mock.calls[0][0];
    expect(userMessage).toMatch(/"passiveIncomeSharePct": 3.2/);
    expect(userMessage).toMatch(/"asOf": "2026-10-01"/);
    expect(userMessage).toMatch(/ACTIVE LENSES[\s\S]*PASSIVE_INCOME_OUTLOOK/);
  });
});
