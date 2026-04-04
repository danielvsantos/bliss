/**
 * Unit tests for insightService.
 *
 * Tests data gathering, prompt construction, data-hash deduplication,
 * and the full generateInsights orchestration.
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
const mockPortfolioHistoryFindMany = jest.fn();
const mockInsightFindFirst = jest.fn();
const mockInsightDeleteMany = jest.fn();
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
    findMany: (...args) => mockPortfolioHistoryFindMany(...args),
  },
  insight: {
    findFirst: (...args) => mockInsightFindFirst(...args),
    deleteMany: (...args) => mockInsightDeleteMany(...args),
    createMany: (...args) => mockInsightCreateMany(...args),
  },
  $transaction: jest.fn((ops) => Promise.all(ops)),
}));

const mockGenerateInsightContent = jest.fn();
jest.mock('../../../services/geminiService', () => ({
  generateInsightContent: (...args) => mockGenerateInsightContent(...args),
}));

jest.mock('../../../services/currencyService', () => ({
  getOrCreateCurrencyRate: jest.fn().mockResolvedValue(1.0),
  getRatesForDateRange: jest.fn().mockResolvedValue(new Map()),
}));

// ─── Import ─────────────────────────────────────────────────────────────────

const { gatherTenantData, buildInsightPrompt, generateInsights } = require('../../../services/insightService');

// ─── Helpers ────────────────────────────────────────────────────────────────

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
      name: 'AAPL', currency: 'USD', currentValue: 10000,
      category: { name: 'Stocks', group: 'Equities', type: 'Investments' },
      debtTerms: null,
    },
  ]);

  mockPortfolioHistoryFindMany.mockResolvedValue([
    { date: new Date('2026-03-01'), valueInUSD: 50000 },
    { date: new Date('2026-03-15'), valueInUSD: 52000 },
  ]);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('insightService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('gatherTenantData()', () => {
    it('returns structured data with all lenses populated', async () => {
      setupBasicTenantData();

      const data = await gatherTenantData('tenant-1');

      expect(data.portfolioCurrency).toBe('USD');
      expect(data.hasTransactions).toBe(true);
      expect(data.hasPortfolio).toBe(true);
      expect(data.portfolioExposure).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'AAPL' })])
      );
      expect(data.netWorthHistory.length).toBeGreaterThan(0);
      expect(data.incomeHistory).toBeDefined();
      expect(data.savingsHistory).toBeDefined();
    });

    it('handles tenant with no data', async () => {
      mockTenantFindUnique.mockResolvedValue({ portfolioCurrency: 'USD' });
      mockAnalyticsFindMany.mockResolvedValue([]);
      mockPortfolioItemFindMany.mockResolvedValue([]);
      mockPortfolioHistoryFindMany.mockResolvedValue([]);

      const data = await gatherTenantData('tenant-empty');

      expect(data.hasTransactions).toBe(false);
      expect(data.hasPortfolio).toBe(false);
      expect(data.hasDebt).toBe(false);
      expect(data.portfolioExposure).toHaveLength(0);
      expect(data.debtHealth).toHaveLength(0);
    });

    it('computes debt health from debt portfolio items', async () => {
      mockTenantFindUnique.mockResolvedValue({ portfolioCurrency: 'USD' });
      mockAnalyticsFindMany.mockResolvedValue([]);
      mockPortfolioItemFindMany.mockResolvedValue([
        {
          name: 'Mortgage', currency: 'USD', currentValue: -250000,
          category: { name: 'Mortgage', group: 'Real Estate', type: 'Debt' },
          debtTerms: { interestRate: 3.5, minimumPayment: 1200 },
        },
      ]);
      mockPortfolioHistoryFindMany.mockResolvedValue([]);

      const data = await gatherTenantData('tenant-debt');

      expect(data.hasDebt).toBe(true);
      expect(data.debtHealth).toHaveLength(1);
      expect(data.debtHealth[0]).toEqual(expect.objectContaining({
        name: 'Mortgage',
        interestRate: 3.5,
      }));
    });
  });

  describe('buildInsightPrompt()', () => {
    it('includes active lenses and financial data in prompt', () => {
      const tenantData = {
        portfolioCurrency: 'USD',
        months: ['2026-01', '2026-02'],
        spendingVelocity: {},
        categoryConcentration: {},
        incomeHistory: [],
        savingsHistory: [],
        portfolioExposure: [],
        debtHealth: [],
        netWorthHistory: [],
        totalInvestmentValue: 0,
        totalDebt: 0,
      };
      const lenses = ['SPENDING_VELOCITY', 'INCOME_STABILITY'];

      const prompt = buildInsightPrompt(tenantData, lenses);

      expect(prompt).toContain('SPENDING_VELOCITY');
      expect(prompt).toContain('INCOME_STABILITY');
      expect(prompt).toContain('USD');
      expect(prompt).toContain('$'); // currency symbol
    });
  });

  describe('generateInsights()', () => {
    it('generates insights and stores them in database', async () => {
      setupBasicTenantData();
      mockInsightFindFirst.mockResolvedValue(null); // no previous batch

      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'Dining costs rising', body: 'Your dining spend rose 15%.', severity: 'WARNING', priority: 70, metadata: {} },
        { lens: 'INCOME_STABILITY', title: 'Stable income', body: 'Consistent salary deposits.', severity: 'POSITIVE', priority: 30, metadata: {} },
      ]);

      const results = await generateInsights('tenant-1');

      expect(mockGenerateInsightContent).toHaveBeenCalled();
      expect(mockInsightCreateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ lens: 'SPENDING_VELOCITY', severity: 'WARNING' }),
          expect.objectContaining({ lens: 'INCOME_STABILITY', severity: 'POSITIVE' }),
        ]),
      }));
      expect(results).toHaveLength(2);
    });

    it('skips generation when data hash is unchanged', async () => {
      setupBasicTenantData();

      // First call to compute the hash
      mockInsightFindFirst.mockResolvedValue(null);
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'Test', body: 'Test body.', severity: 'INFO', priority: 50 },
      ]);
      const first = await generateInsights('tenant-1');
      const firstDataHash = first[0]?.dataHash;

      // Second call — return the same hash from DB
      jest.clearAllMocks();
      setupBasicTenantData();
      mockInsightFindFirst.mockResolvedValue({ dataHash: firstDataHash, batchId: 'batch-1' });

      const second = await generateInsights('tenant-1');

      expect(second).toHaveLength(0);
      expect(mockGenerateInsightContent).not.toHaveBeenCalled();
    });

    it('returns empty array when tenant has no data', async () => {
      mockTenantFindUnique.mockResolvedValue({ portfolioCurrency: 'USD' });
      mockAnalyticsFindMany.mockResolvedValue([]);
      mockPortfolioItemFindMany.mockResolvedValue([]);
      mockPortfolioHistoryFindMany.mockResolvedValue([]);

      const results = await generateInsights('tenant-empty');

      expect(results).toHaveLength(0);
      expect(mockGenerateInsightContent).not.toHaveBeenCalled();
    });

    it('handles LLM returning empty or invalid insights', async () => {
      setupBasicTenantData();
      mockInsightFindFirst.mockResolvedValue(null);
      mockGenerateInsightContent.mockResolvedValue([]);

      const results = await generateInsights('tenant-1');

      expect(results).toHaveLength(0);
      expect(mockInsightCreateMany).not.toHaveBeenCalled();
    });

    it('clamps priority and validates severity', async () => {
      setupBasicTenantData();
      mockInsightFindFirst.mockResolvedValue(null);
      mockGenerateInsightContent.mockResolvedValue([
        { lens: 'SPENDING_VELOCITY', title: 'Test', body: 'Body.', severity: 'INVALID', priority: 200 },
      ]);

      const results = await generateInsights('tenant-1');

      // Invalid severity defaults to INFO, priority clamped to 100
      expect(results[0].severity).toBe('INFO');
      expect(results[0].priority).toBe(100);
    });
  });
});
