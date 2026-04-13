/**
 * Unit tests for insightService (v1 — tiered architecture).
 *
 * Covers:
 *   - generateTieredInsights() for each of the 4 tiers
 *     (MONTHLY / QUARTERLY / ANNUAL / PORTFOLIO)
 *   - generateAllDueTiers() calendar gating (monthly on days 1-3,
 *     quarterly on first 5 days of Jan/Apr/Jul/Oct, annual on first 5 of Jan)
 *   - Completeness gating (canRun=false → skipped unless force=true)
 *   - Additive persistence + dedup via (tenantId, tier, periodKey, dataHash)
 *   - Dismissed state preservation across regenerations
 *   - filterActiveLenses() tier/data-dependent lens selection
 *   - Severity/priority validation + category assignment
 *
 * Note: the DAILY tier was retired. The daily 6 AM UTC cron is kept purely
 * as a scheduling heartbeat for the calendar-gated tiers.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockTenantFindUnique = jest.fn();
const mockAnalyticsFindMany = jest.fn();
const mockPortfolioItemFindMany = jest.fn();
const mockPortfolioHistoryGroupBy = jest.fn();
const mockSecurityMasterFindMany = jest.fn();
const mockInsightFindFirst = jest.fn();
const mockInsightFindMany = jest.fn();
const mockInsightCreateMany = jest.fn();
jest.mock('../../../../prisma/prisma.js', () => ({
  tenant: {
    findUnique: (...args) => mockTenantFindUnique(...args),
  },
  analyticsCacheMonthly: {
    findMany: (...args) => mockAnalyticsFindMany(...args),
  },
  portfolioItem: {
    findMany: (...args) => mockPortfolioItemFindMany(...args),
  },
  portfolioValueHistory: {
    // `gatherNetWorthHistory` aggregates server-side via groupBy — see the
    // P6009 payload-size fix in insightService.js. Tests must mock groupBy,
    // not findMany.
    groupBy: (...args) => mockPortfolioHistoryGroupBy(...args),
  },
  securityMaster: {
    findMany: (...args) => mockSecurityMasterFindMany(...args),
  },
  insight: {
    findFirst: (...args) => mockInsightFindFirst(...args),
    findMany: (...args) => mockInsightFindMany(...args),
    createMany: (...args) => mockInsightCreateMany(...args),
  },
  $transaction: jest.fn((ops) => Promise.all(ops)),
}));

const mockGenerateInsightContent = jest.fn();
jest.mock('../../../services/geminiService', () => ({
  generateInsightContent: (...args) => mockGenerateInsightContent(...args),
}));

// insightService (v2) must be a pure read consumer of CurrencyRate. It only
// calls `getRatesForDateRange` (bulk range scan) via `prefetchRatesForTier`.
// `getOrCreateCurrencyRate` is forbidden — see insightService.hygiene.test.js
// for the structural invariant that enforces this.
jest.mock('../../../services/currencyService', () => ({
  getRatesForDateRange: jest.fn().mockResolvedValue(new Map()),
}));

const mockCheckTierCompleteness = jest.fn();
jest.mock('../../../services/dataCompletenessService', () => ({
  checkTierCompleteness: (...args) => mockCheckTierCompleteness(...args),
  getPeriodKey: jest.requireActual('../../../services/dataCompletenessService').getPeriodKey,
  getQuarterMonths: jest.requireActual('../../../services/dataCompletenessService').getQuarterMonths,
  getQuarterFromMonth: jest.requireActual('../../../services/dataCompletenessService').getQuarterFromMonth,
}));

// ─── Import ─────────────────────────────────────────────────────────────────

const {
  generateTieredInsights,
  generateAllDueTiers,
  derivePeriodKey,
  gatherEquityFundamentals,
  filterActiveLenses,
  TIER_LENSES,
  LENS_CATEGORY_MAP,
  VALID_TIERS,
} = require('../../../services/insightService');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Seeds the Prisma mocks so that MONTHLY / QUARTERLY / ANNUAL / PORTFOLIO
 * data gathering produces a tenant with both transactions and a portfolio
 * item (used by filterActiveLenses).
 */
function setupBasicTenantData() {
  mockTenantFindUnique.mockResolvedValue({ portfolioCurrency: 'USD' });

  const now = new Date();
  const curMonth = now.getMonth() + 1;
  const curYear = now.getFullYear();

  mockAnalyticsFindMany.mockResolvedValue([
    { year: curYear, month: curMonth, type: 'Income', group: 'Salary', balance: -5000, currency: 'USD' },
    { year: curYear, month: curMonth, type: 'Essentials', group: 'Housing', balance: 1500, currency: 'USD' },
    { year: curYear, month: curMonth, type: 'Lifestyle', group: 'Dining', balance: 300, currency: 'USD' },
  ]);

  mockPortfolioItemFindMany.mockResolvedValue([
    {
      name: 'AAPL', symbol: 'AAPL', currency: 'USD',
      currentValue: 10000, costBasis: 8000, quantity: 50, realizedPnL: 0,
      category: { name: 'Stocks', group: 'Equities', type: 'Investments' },
      debtTerms: null,
    },
  ]);

  // Matches the shape returned by
  // `prisma.portfolioValueHistory.groupBy({ by: ['date'], _sum: { valueInUSD } })`.
  mockPortfolioHistoryGroupBy.mockResolvedValue([
    { date: new Date('2026-03-01'), _sum: { valueInUSD: 50000 } },
    { date: new Date('2026-03-15'), _sum: { valueInUSD: 52000 } },
  ]);

  mockSecurityMasterFindMany.mockResolvedValue([
    {
      symbol: 'AAPL', name: 'Apple Inc', sector: 'Technology', industry: 'Consumer Electronics',
      country: 'US', peRatio: 28.5, dividendYield: 0.5, trailingEps: 6.5,
      latestEpsActual: 1.8, latestEpsSurprise: 0.05, week52High: 200, week52Low: 150,
      averageVolume: 50000000, assetType: 'EQUITY',
    },
  ]);
}

/** Mock completeness passing for any tier. */
function completenessPasses(overrides = {}) {
  mockCheckTierCompleteness.mockResolvedValue({
    canRun: true,
    details: null,
    comparisonAvailable: true,
    ...overrides,
  });
}

/** Mock completeness failing for any tier. */
function completenessFails(reason = 'Insufficient data') {
  mockCheckTierCompleteness.mockResolvedValue({
    canRun: false,
    details: { reason },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('insightService (v1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no existing insight row, no previous dismissals
    mockInsightFindFirst.mockResolvedValue(null);
    mockInsightFindMany.mockResolvedValue([]);
    mockInsightCreateMany.mockResolvedValue({ count: 0 });
  });

  // ── Constants & static exports ───────────────────────────────────────────
  describe('exports', () => {
    it('exposes VALID_TIERS with the 4 active tiers (no DAILY)', () => {
      expect(VALID_TIERS).toEqual(['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PORTFOLIO']);
    });

    it('does not expose a DAILY tier key in TIER_LENSES', () => {
      expect(TIER_LENSES.DAILY).toBeUndefined();
    });

    it('TIER_LENSES has entries for every valid tier', () => {
      for (const tier of VALID_TIERS) {
        expect(TIER_LENSES[tier]).toBeDefined();
        expect(TIER_LENSES[tier].length).toBeGreaterThan(0);
      }
    });

    it('LENS_CATEGORY_MAP maps all known lenses to a valid category', () => {
      const validCategories = new Set(['SPENDING', 'INCOME', 'SAVINGS', 'PORTFOLIO', 'DEBT', 'NET_WORTH']);
      for (const [lens, category] of Object.entries(LENS_CATEGORY_MAP)) {
        expect(validCategories.has(category)).toBe(true);
        expect(typeof lens).toBe('string');
      }
    });
  });

  // ── filterActiveLenses ───────────────────────────────────────────────────
  describe('filterActiveLenses()', () => {
    it('returns portfolio lenses only when equity holdings exist', () => {
      const data = { hasTransactions: false, equityHoldings: [{ symbol: 'AAPL' }] };
      const result = filterActiveLenses('PORTFOLIO', data);
      expect(result).toContain('PORTFOLIO_EXPOSURE');
      expect(result).toContain('SECTOR_CONCENTRATION');
    });

    it('drops debt lenses when tenant has no debt', () => {
      const data = { hasTransactions: true, hasDebt: false, debtHealth: [], netWorthHistory: [] };
      const result = filterActiveLenses('MONTHLY', data);
      expect(result).not.toContain('DEBT_HEALTH');
    });

    it('drops net-worth lenses when history is empty', () => {
      const data = { hasTransactions: true, hasDebt: false, debtHealth: [], netWorthHistory: [] };
      const result = filterActiveLenses('MONTHLY', data);
      expect(result).not.toContain('NET_WORTH_TRAJECTORY');
      expect(result).not.toContain('NET_WORTH_MILESTONES');
    });

    it('returns empty when tenant has no transactions and no portfolio', () => {
      const data = { hasTransactions: false, hasDebt: false, debtHealth: [], netWorthHistory: [] };
      const result = filterActiveLenses('MONTHLY', data);
      expect(result).toEqual([]);
    });
  });

  // ── generateTieredInsights — MONTHLY ─────────────────────────────────────
  describe('generateTieredInsights(MONTHLY)', () => {
    it('emits a YYYY-MM period key and persists the insight with tier=MONTHLY', async () => {
      setupBasicTenantData();
      completenessPasses({ comparisonAvailable: { previousMonth: true, sameMonthLastYear: false } });

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'INCOME_STABILITY', title: 'Stable', body: 'Consistent salary.', severity: 'POSITIVE', priority: 30 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3, periodKey: '2026-03',
      });

      expect(mockCheckTierCompleteness).toHaveBeenCalledWith(
        'tenant-1', 'MONTHLY', expect.any(Object),
      );
      // The Flash model path was retired with DAILY; generateInsightContent
      // is called with a single positional argument (the prompt).
      expect(mockGenerateInsightContent).toHaveBeenCalledWith(expect.any(String));
      expect(result.periodKey).toBe('2026-03');
      expect(mockInsightCreateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ tier: 'MONTHLY', periodKey: '2026-03', category: 'INCOME' }),
        ]),
      }));
    });

    it('skips when completeness check fails', async () => {
      completenessFails('Month is not yet closed');
      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3,
      });
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('Month is not yet closed');
      expect(mockGenerateInsightContent).not.toHaveBeenCalled();
      expect(mockInsightCreateMany).not.toHaveBeenCalled();
    });

    it('bypasses completeness when force=true', async () => {
      setupBasicTenantData();
      mockCheckTierCompleteness.mockResolvedValue({
        canRun: true, forced: true, details: null, comparisonAvailable: true,
      });

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'INFO', priority: 50 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3, force: true,
      });
      expect(mockCheckTierCompleteness).toHaveBeenCalledWith(
        'tenant-1', 'MONTHLY',
        expect.objectContaining({ force: true }),
      );
      expect(result.insights).toHaveLength(1);
    });
  });

  // ── generateTieredInsights — QUARTERLY ───────────────────────────────────
  describe('generateTieredInsights(QUARTERLY)', () => {
    it('emits YYYY-Qn period key', async () => {
      setupBasicTenantData();
      completenessPasses({
        comparisonAvailable: { previousQuarter: true, sameQuarterLastYear: true },
      });

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SAVINGS_RATE', title: 'Saving well', body: '20% savings rate.', severity: 'POSITIVE', priority: 40 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'QUARTERLY', {
        year: 2026, quarter: 1, periodKey: '2026-Q1',
      });

      expect(mockGenerateInsightContent).toHaveBeenCalledWith(expect.any(String));
      expect(result.periodKey).toBe('2026-Q1');
    });
  });

  // ── generateTieredInsights — ANNUAL ──────────────────────────────────────
  describe('generateTieredInsights(ANNUAL)', () => {
    it('emits YYYY period key', async () => {
      setupBasicTenantData();
      completenessPasses({ comparisonAvailable: { previousYear: true, twoYearsAgo: false } });

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'NET_WORTH_TRAJECTORY', title: 'Growth', body: 'Up 15%.', severity: 'POSITIVE', priority: 60 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'ANNUAL', {
        year: 2025, periodKey: '2025',
      });
      expect(result.periodKey).toBe('2025');
    });
  });

  // ── generateTieredInsights — PORTFOLIO ───────────────────────────────────
  describe('generateTieredInsights(PORTFOLIO)', () => {
    it('gathers SecurityMaster fundamentals and inserts portfolio-category insights', async () => {
      setupBasicTenantData();
      completenessPasses();

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SECTOR_CONCENTRATION', title: 'Tech-heavy', body: '80% tech.', severity: 'WARNING', priority: 65 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'PORTFOLIO');

      // PORTFOLIO tier should have called SecurityMaster
      expect(mockSecurityMasterFindMany).toHaveBeenCalled();
      expect(result.insights).toHaveLength(1);
      expect(mockInsightCreateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            tier: 'PORTFOLIO',
            category: 'PORTFOLIO',
            lens: 'SECTOR_CONCENTRATION',
          }),
        ]),
      }));
    });

    it('skips when tenant has no equity holdings', async () => {
      mockTenantFindUnique.mockResolvedValue({ portfolioCurrency: 'USD' });
      mockPortfolioItemFindMany.mockResolvedValue([]);
      mockSecurityMasterFindMany.mockResolvedValue([]);
      completenessPasses();

      const result = await generateTieredInsights('tenant-empty', 'PORTFOLIO');
      expect(result.skipped).toBe(true);
      expect(mockGenerateInsightContent).not.toHaveBeenCalled();
    });
  });

  // ── Dedup via dataHash ───────────────────────────────────────────────────
  describe('dedup', () => {
    it('skips when a row with matching (tenantId, tier, periodKey, dataHash) exists', async () => {
      setupBasicTenantData();
      completenessPasses();
      mockInsightFindFirst.mockResolvedValue({ id: 1, batchId: 'existing-batch' });

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3, periodKey: '2026-03',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toMatch(/unchanged/i);
      expect(mockGenerateInsightContent).not.toHaveBeenCalled();
      expect(mockInsightCreateMany).not.toHaveBeenCalled();
    });

    it('inserts anyway when force=true even if existing row matches', async () => {
      setupBasicTenantData();
      mockCheckTierCompleteness.mockResolvedValue({ canRun: true, forced: true, details: null, comparisonAvailable: true });
      mockInsightFindFirst.mockResolvedValue({ id: 1, batchId: 'existing-batch' });

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'INFO', priority: 50 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3, periodKey: '2026-03', force: true,
      });

      expect(result.insights).toHaveLength(1);
      expect(mockInsightCreateMany).toHaveBeenCalled();
    });
  });

  // ── Dismissed state preservation ─────────────────────────────────────────
  describe('dismissed state preservation', () => {
    it('marks a regenerated insight as dismissed when a prior dismissal exists for the same (lens, periodKey)', async () => {
      setupBasicTenantData();
      completenessPasses();

      // Pre-existing dismissal for SPENDING_VELOCITY in this period
      mockInsightFindMany.mockResolvedValue([{ lens: 'SPENDING_VELOCITY' }]);

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'WARNING', priority: 60 },
        { lens: 'INCOME_STABILITY', title: 'a', body: 'b', severity: 'INFO', priority: 50 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3, periodKey: '2026-03',
      });

      // SPENDING_VELOCITY should inherit dismissed=true; INCOME_STABILITY should not
      const dismissed = result.insights.find((i) => i.lens === 'SPENDING_VELOCITY');
      const notDismissed = result.insights.find((i) => i.lens === 'INCOME_STABILITY');
      expect(dismissed?.dismissed).toBe(true);
      expect(notDismissed?.dismissed).toBeFalsy();
    });
  });

  // ── Validation / clamping ────────────────────────────────────────────────
  describe('validation', () => {
    it('clamps priority to [1..100] and defaults invalid severity to INFO', async () => {
      setupBasicTenantData();
      completenessPasses();

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'BOGUS', priority: 9999 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3,
      });
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0].severity).toBe('INFO');
      expect(result.insights[0].priority).toBe(100);
    });

    it('assigns category from LENS_CATEGORY_MAP when LLM omits it', async () => {
      setupBasicTenantData();
      completenessPasses();

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SAVINGS_RATE', title: 'x', body: 'y', severity: 'POSITIVE', priority: 50 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3,
      });
      expect(result.insights[0].category).toBe(LENS_CATEGORY_MAP.SAVINGS_RATE);
    });

    it('returns empty when LLM returns an empty array', async () => {
      setupBasicTenantData();
      completenessPasses();
      mockGenerateInsightContent.mockResolvedValue([]);

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3,
      });
      expect(result.insights).toEqual([]);
      expect(mockInsightCreateMany).not.toHaveBeenCalled();
    });
  });

  // ── generateAllDueTiers() calendar gating ────────────────────────────────
  describe('generateAllDueTiers()', () => {
    let originalDate;
    beforeAll(() => {
      originalDate = global.Date;
    });
    afterEach(() => {
      global.Date = originalDate;
    });

    /** Freeze "now" to a specific wall-clock date while leaving Date construction working for other args. */
    function freezeNow(isoString) {
      const realDate = originalDate;
      class MockDate extends realDate {
        constructor(...args) {
          if (args.length === 0) return new realDate(isoString);
          return new realDate(...args);
        }
        static now() { return new realDate(isoString).getTime(); }
      }
      global.Date = MockDate;
    }

    it('returns empty results mid-month when no tier window is open', async () => {
      freezeNow('2026-05-15T12:00:00Z'); // mid-month, nothing else due
      setupBasicTenantData();
      completenessPasses();
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'INFO', priority: 50 },
      ]);

      const results = await generateAllDueTiers('tenant-1');

      // DAILY tier was retired; mid-month produces no tiered output
      expect(results.DAILY).toBeUndefined();
      expect(results.MONTHLY).toBeUndefined();
      expect(results.QUARTERLY).toBeUndefined();
      expect(results.ANNUAL).toBeUndefined();
    });

    it('triggers MONTHLY when current day is within the first 3 days of a month', async () => {
      // Use May 1st — yesterday is April 30 so the service targets April (prev month).
      // (On May 2nd/3rd the service would look at yesterday=May 1st/2nd and incorrectly target May.)
      freezeNow('2026-05-01T12:00:00Z');
      setupBasicTenantData();
      completenessPasses();
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'INFO', priority: 50 },
      ]);

      const results = await generateAllDueTiers('tenant-1');

      expect(results.MONTHLY).toBeDefined();
      // April (month 4) should be the monthly period we generate for
      expect(mockCheckTierCompleteness).toHaveBeenCalledWith(
        'tenant-1', 'MONTHLY',
        expect.objectContaining({ year: 2026, month: 4 }),
      );
    });

    it('triggers QUARTERLY during the first 5 days of Jan/Apr/Jul/Oct', async () => {
      freezeNow('2026-04-03T12:00:00Z'); // April 3 — Q1 just closed
      setupBasicTenantData();
      completenessPasses();
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'INFO', priority: 50 },
      ]);

      const results = await generateAllDueTiers('tenant-1');

      expect(results.QUARTERLY).toBeDefined();
      expect(mockCheckTierCompleteness).toHaveBeenCalledWith(
        'tenant-1', 'QUARTERLY',
        expect.objectContaining({ year: 2026, quarter: 1 }),
      );
    });

    it('triggers ANNUAL during the first 5 days of January', async () => {
      freezeNow('2026-01-03T12:00:00Z'); // Jan 3 — annual window open
      setupBasicTenantData();
      completenessPasses();
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'NET_WORTH_TRAJECTORY', title: 'x', body: 'y', severity: 'POSITIVE', priority: 50 },
      ]);

      const results = await generateAllDueTiers('tenant-1');

      expect(results.ANNUAL).toBeDefined();
      expect(mockCheckTierCompleteness).toHaveBeenCalledWith(
        'tenant-1', 'ANNUAL',
        expect.objectContaining({ year: 2025 }),
      );
    });

    it('does not trigger MONTHLY outside the first 3 days', async () => {
      freezeNow('2026-05-04T12:00:00Z'); // 4th — outside window
      setupBasicTenantData();
      completenessPasses();
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'INFO', priority: 50 },
      ]);

      const results = await generateAllDueTiers('tenant-1');
      expect(results.MONTHLY).toBeUndefined();
    });
  });

  // ── derivePeriodKey — regression for v1.1 period-selector bug ────────────
  //
  // The frontend's "Generate all" and per-tier refresh send explicit
  // year/month/quarter but no periodKey. Before the fix, the service fell
  // back to `getPeriodKey(tier, new Date())` which used *today's* period
  // — an ANNUAL report about 2025 landed under 2026, a QUARTERLY Q1 under
  // Q2, a MONTHLY March under April. Lock this down at the helper level.
  describe('derivePeriodKey()', () => {
    it('prefers an explicit periodKey when provided', () => {
      expect(derivePeriodKey('MONTHLY', { periodKey: '2099-12', year: 2026, month: 3 }))
        .toBe('2099-12');
    });

    it('derives a MONTHLY key from year+month (not today)', () => {
      expect(derivePeriodKey('MONTHLY', { year: 2026, month: 3 })).toBe('2026-03');
      expect(derivePeriodKey('MONTHLY', { year: 2025, month: 12 })).toBe('2025-12');
    });

    it('derives a QUARTERLY key from year+quarter (not today)', () => {
      expect(derivePeriodKey('QUARTERLY', { year: 2026, quarter: 1 })).toBe('2026-Q1');
      expect(derivePeriodKey('QUARTERLY', { year: 2025, quarter: 4 })).toBe('2025-Q4');
    });

    it('derives an ANNUAL key from year (not today)', () => {
      expect(derivePeriodKey('ANNUAL', { year: 2025 })).toBe('2025');
    });

    it('falls back to the current ISO week for PORTFOLIO (current-state tier)', () => {
      const key = derivePeriodKey('PORTFOLIO', {});
      // ISO week format: YYYY-Www
      expect(key).toMatch(/^\d{4}-W\d{2}$/);
    });
  });

  describe('generateTieredInsights periodKey derivation (v1.1 regression)', () => {
    it('ANNUAL generated during 2026 for year=2025 lands under periodKey "2025", not "2026"', async () => {
      setupBasicTenantData();
      completenessPasses({ comparisonAvailable: { previousYear: true, twoYearsAgo: false } });
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'NET_WORTH_TRAJECTORY', title: 'x', body: 'y', severity: 'POSITIVE', priority: 50 },
      ]);

      // Frontend sends year but NO periodKey — this was the bug path.
      const result = await generateTieredInsights('tenant-1', 'ANNUAL', { year: 2025, force: true });

      expect(result.periodKey).toBe('2025');
      expect(mockInsightCreateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ tier: 'ANNUAL', periodKey: '2025' }),
        ]),
      }));
    });

    it('QUARTERLY generated during Q2 for Q1 lands under "2026-Q1", not "2026-Q2"', async () => {
      setupBasicTenantData();
      completenessPasses();
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SAVINGS_RATE', title: 'x', body: 'y', severity: 'POSITIVE', priority: 50 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'QUARTERLY', {
        year: 2026, quarter: 1, force: true,
      });

      expect(result.periodKey).toBe('2026-Q1');
      expect(mockInsightCreateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ tier: 'QUARTERLY', periodKey: '2026-Q1' }),
        ]),
      }));
    });

    it('MONTHLY generated during April for March lands under "2026-03", not "2026-04"', async () => {
      setupBasicTenantData();
      completenessPasses();
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'x', body: 'y', severity: 'INFO', priority: 50 },
      ]);

      const result = await generateTieredInsights('tenant-1', 'MONTHLY', {
        year: 2026, month: 3, force: true,
      });

      expect(result.periodKey).toBe('2026-03');
      expect(mockInsightCreateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ tier: 'MONTHLY', periodKey: '2026-03' }),
        ]),
      }));
    });
  });

  // ── gatherEquityFundamentals — currency conversion (v1.1 regression) ────
  //
  // Bug: Brazilian tenant reports in BRL but holds a BRL asset with
  // currentValue=1_000_000 (R$1M). Before the fix, the function shipped
  // raw `currentValue` to Gemini without routing it through the rate
  // cache, and a downstream BRL→BRL identity pass meant nothing broke —
  // but the cross-currency case (BRL reporter holding a USD asset) shipped
  // the raw USD value labeled as BRL in the prompt.
  describe('gatherEquityFundamentals() currency conversion', () => {
    beforeEach(() => {
      mockPortfolioItemFindMany.mockReset();
      mockSecurityMasterFindMany.mockReset();
    });

    it('converts currentValue/costBasis/realizedPnL from native currency to portfolio currency', async () => {
      mockPortfolioItemFindMany.mockResolvedValue([
        {
          id: 1, symbol: 'AAPL', currency: 'USD',
          currentValue: 1000, costBasis: 800, quantity: 5, realizedPnL: 50,
        },
      ]);
      mockSecurityMasterFindMany.mockResolvedValue([
        { symbol: 'AAPL', name: 'Apple Inc', sector: 'Technology', industry: 'Consumer Electronics',
          country: 'US', peRatio: 28.5, dividendYield: 0.5, trailingEps: 6.5,
          latestEpsActual: null, latestEpsSurprise: null, week52High: 200, week52Low: 150,
          averageVolume: null, assetType: 'EQUITY' },
      ]);

      // Rate cache: 1 USD = 5 BRL on today's date
      const today = new Date().toISOString().slice(0, 10);
      const rateCache = { [`${today}_USD_BRL`]: 5 };

      const result = await gatherEquityFundamentals('tenant-1', 'BRL', rateCache);

      expect(result.holdings).toHaveLength(1);
      const [h] = result.holdings;
      expect(h.nativeCurrency).toBe('USD');
      // $1000 @ 5 = R$5000
      expect(h.currentValue).toBe(5000);
      // $800 @ 5 = R$4000
      expect(h.costBasis).toBe(4000);
      // $50 @ 5 = R$250
      expect(h.realizedPnL).toBe(250);
      // unrealized = currentValue - costBasis (already in BRL)
      expect(h.unrealizedPnL).toBe(1000);
      // Sector allocation and totalValue should also use converted values
      expect(result.totalValue).toBe(5000);
      expect(result.sectorAllocation.Technology.value).toBe(5000);
      expect(result.sectorAllocation.Technology.percent).toBe(100);
    });

    it('is a no-op when native currency equals portfolio currency', async () => {
      mockPortfolioItemFindMany.mockResolvedValue([
        {
          id: 1, symbol: 'VALE3', currency: 'BRL',
          currentValue: 1_000_000, costBasis: 900_000, quantity: 100, realizedPnL: 0,
        },
      ]);
      mockSecurityMasterFindMany.mockResolvedValue([
        { symbol: 'VALE3', name: 'Vale SA', sector: 'Basic Materials', industry: 'Steel',
          country: 'BR', peRatio: 5.2, dividendYield: 10.2, trailingEps: 3.1,
          latestEpsActual: null, latestEpsSurprise: null, week52High: 90, week52Low: 50,
          averageVolume: null, assetType: 'EQUITY' },
      ]);

      // Empty cache — conversion should short-circuit since from === to
      const result = await gatherEquityFundamentals('tenant-1', 'BRL', {});

      const [h] = result.holdings;
      expect(h.nativeCurrency).toBe('BRL');
      expect(h.currentValue).toBe(1_000_000);
      expect(h.costBasis).toBe(900_000);
      expect(h.unrealizedPnL).toBe(100_000);
    });

    it('returns an empty structure when tenant has no investment holdings', async () => {
      mockPortfolioItemFindMany.mockResolvedValue([]);
      mockSecurityMasterFindMany.mockResolvedValue([]);

      const result = await gatherEquityFundamentals('tenant-empty', 'USD', {});
      expect(result.holdings).toEqual([]);
      expect(result.totalValue).toBe(0);
    });

    it('degrades gracefully (keeps native value) on a rate cache miss for a cross-currency holding', async () => {
      mockPortfolioItemFindMany.mockResolvedValue([
        { id: 1, symbol: 'AAPL', currency: 'USD',
          currentValue: 1000, costBasis: 800, quantity: 5, realizedPnL: 0 },
      ]);
      mockSecurityMasterFindMany.mockResolvedValue([
        { symbol: 'AAPL', name: 'Apple Inc', sector: 'Technology', industry: 'Consumer Electronics',
          country: 'US', peRatio: null, dividendYield: null, trailingEps: null,
          latestEpsActual: null, latestEpsSurprise: null, week52High: null, week52Low: null,
          averageVolume: null, assetType: 'EQUITY' },
      ]);

      // Empty cache — convertAmount will return the raw amount unchanged.
      const result = await gatherEquityFundamentals('tenant-1', 'BRL', {});

      const [h] = result.holdings;
      // Fallback behavior: unconverted value, not zero — same graceful
      // fallback the rest of the service uses.
      expect(h.currentValue).toBe(1000);
      expect(h.costBasis).toBe(800);
    });

    it('uses category processingHint as sector fallback when SecurityMaster has no record', async () => {
      mockPortfolioItemFindMany.mockResolvedValue([
        {
          id: 1, symbol: 'SPY', currency: 'USD',
          currentValue: 5000, costBasis: 4500, quantity: 10, realizedPnL: 0,
          category: { name: 'ETFs', processingHint: 'API_FUND' },
        },
        {
          id: 2, symbol: 'BTC', currency: 'USD',
          currentValue: 3000, costBasis: 2000, quantity: 0.05, realizedPnL: 0,
          category: { name: 'Crypto', processingHint: 'API_CRYPTO' },
        },
        {
          id: 3, symbol: 'HOUSE', currency: 'USD',
          currentValue: 200000, costBasis: 180000, quantity: 1, realizedPnL: 0,
          category: { name: 'Real Estate', processingHint: 'MANUAL' },
        },
      ]);
      // No SecurityMaster records for any of these
      mockSecurityMasterFindMany.mockResolvedValue([]);

      const result = await gatherEquityFundamentals('tenant-1', 'USD', {});

      expect(result.holdings).toHaveLength(3);
      // ETF → 'ETFs & Funds' from processingHint map
      expect(result.holdings[0].sector).toBe('ETFs & Funds');
      // Crypto → 'Cryptocurrency' from processingHint map
      expect(result.holdings[1].sector).toBe('Cryptocurrency');
      // Manual → 'Alternative Assets' from processingHint map
      expect(result.holdings[2].sector).toBe('Alternative Assets');
      // Country fallback should be 'Global', not 'Unknown'
      expect(result.holdings[0].country).toBe('Global');
      // Sector allocation should use the derived labels
      expect(result.sectorAllocation['ETFs & Funds']).toBeDefined();
      expect(result.sectorAllocation['Cryptocurrency']).toBeDefined();
      expect(result.sectorAllocation['Alternative Assets']).toBeDefined();
      expect(result.sectorAllocation['Unknown']).toBeUndefined();
    });
  });
});
