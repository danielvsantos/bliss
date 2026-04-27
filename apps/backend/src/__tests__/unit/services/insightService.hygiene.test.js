/**
 * Side-effect hygiene test for insightService.
 *
 * The insights engine must be a pure read consumer:
 *   - Never writes to CurrencyRate (or any table other than Insight)
 *   - Never calls external HTTP APIs (Gemini is the only allowed egress,
 *     and it is mocked here)
 *   - Never imports getOrCreateCurrencyRate (which is a write-through cache
 *     and the root of the pre-v2 currency rate bug)
 *
 * If any of these invariants break in the future, CI will fail immediately
 * rather than letting the regression land silently and get discovered by
 * CurrencyLayer billing alerts or a surprise portfolio rebuild.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Every CurrencyRate write operation is a hard failure.
const forbid = (op) => () => {
  throw new Error(`insightService attempted forbidden operation: ${op}`);
};

jest.mock('../../../../prisma/prisma.js', () => ({
  tenant: {
    findUnique: jest.fn().mockResolvedValue({ portfolioCurrency: 'EUR' }),
  },
  analyticsCacheMonthly: {
    findMany: jest.fn().mockResolvedValue([
      // Minimal data so hasTransactions=true for non-PORTFOLIO tiers
      { year: 2026, month: 3, type: 'Income', group: 'Salary', balance: -5000, currency: 'EUR' },
      { year: 2026, month: 3, type: 'Essentials', group: 'Housing', balance: 1500, currency: 'EUR' },
    ]),
  },
  portfolioItem: {
    // Returns a non-EUR position so the rate cache actually has to do work.
    // `PortfolioItem` has no `ticker` field — the symbol lives in `symbol`.
    findMany: jest.fn().mockResolvedValue([
      {
        id: 'p1',
        name: 'AAPL',
        symbol: 'AAPL',
        currency: 'USD',
        currentValue: 10000,
        costBasis: 8000,
        quantity: 50,
        realizedPnL: 0,
        category: { name: 'Stocks', group: 'Equities', type: 'Investments' },
        debtTerms: null,
      },
    ]),
  },
  portfolioValueHistory: {
    // `gatherNetWorthHistory` aggregates server-side via groupBy to stay
    // under Prisma Accelerate's 5MB response limit (P6009). See the fix in
    // insightService.js.
    groupBy: jest.fn().mockResolvedValue([
      { date: new Date('2026-03-01'), _sum: { valueInUSD: 50000 } },
      { date: new Date('2026-03-15'), _sum: { valueInUSD: 52000 } },
    ]),
  },
  securityMaster: {
    findMany: jest.fn().mockResolvedValue([
      {
        symbol: 'AAPL',
        name: 'Apple Inc',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        country: 'US',
        peRatio: 28.5,
        dividendYield: 0.5,
        trailingEps: 6.5,
        latestEpsActual: 1.8,
        latestEpsSurprise: 0.05,
        week52High: 200,
        week52Low: 150,
        averageVolume: 50000000,
        assetType: 'EQUITY',
      },
    ]),
  },
  insight: {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  transaction: {
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  currencyRate: {
    // Reads that the planner is allowed to make — return empty map-compatible rows
    findMany: jest.fn().mockResolvedValue([]),
    // Every write path + the individual-rate lookup path is forbidden
    findUnique: forbid('currencyRate.findUnique'),
    findFirst: forbid('currencyRate.findFirst'),
    create: forbid('currencyRate.create'),
    createMany: forbid('currencyRate.createMany'),
    upsert: forbid('currencyRate.upsert'),
    update: forbid('currencyRate.update'),
    updateMany: forbid('currencyRate.updateMany'),
    delete: forbid('currencyRate.delete'),
    deleteMany: forbid('currencyRate.deleteMany'),
  },
}));

// Any attempt to hit a network endpoint is a hard failure.
jest.mock('axios', () => ({
  get: jest.fn(() => {
    throw new Error('insightService attempted external HTTP GET via axios');
  }),
  post: jest.fn(() => {
    throw new Error('insightService attempted external HTTP POST via axios');
  }),
}));

// currencyService owns its own PrismaClient instance for the legitimate
// write-through path used by the valuation pipeline. The insights engine
// must never call that path. Mock it so any attempt fails loudly.
//
// Note: getRatesForDateRange is allowed (it's a read-only range scan), but
// we keep it a no-op map here so the tier tests exercise the in-memory
// fallback path in lookupCurrencyRate.
jest.mock('../../../services/currencyService', () => ({
  getOrCreateCurrencyRate: jest.fn(() => {
    throw new Error(
      'insightService attempted to call getOrCreateCurrencyRate (write-through forbidden)',
    );
  }),
  fetchHistoricalRate: jest.fn(() => {
    throw new Error('insightService attempted to call fetchHistoricalRate (network forbidden)');
  }),
  getRatesForDateRange: jest.fn().mockResolvedValue(new Map()),
}));

// Gemini is the only allowed external side effect, and it is mocked so we
// never actually leave the process.
jest.mock('../../../services/llm', () => ({
  generateInsightContent: jest.fn().mockResolvedValue([
    {
      lens: 'SPENDING_VELOCITY',
      title: 'test',
      body: 'test',
      severity: 'INFO',
      priority: 50,
      metadata: {},
    },
  ]),
}));

jest.mock('../../../services/dataCompletenessService', () => ({
  checkTierCompleteness: jest.fn().mockResolvedValue({
    canRun: true,
    forced: true,
    details: null,
    comparisonAvailable: true,
  }),
  getPeriodKey: jest.requireActual('../../../services/dataCompletenessService').getPeriodKey,
  getQuarterMonths: jest.requireActual('../../../services/dataCompletenessService').getQuarterMonths,
  getQuarterFromMonth: jest.requireActual('../../../services/dataCompletenessService').getQuarterFromMonth,
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const { generateTieredInsights } = require('../../../services/insightService');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('insightService — side-effect hygiene', () => {
  const TIERS = [
    { tier: 'MONTHLY', params: { year: 2026, month: 3, force: true } },
    { tier: 'QUARTERLY', params: { year: 2026, quarter: 1, force: true } },
    { tier: 'ANNUAL', params: { year: 2025, force: true } },
    { tier: 'PORTFOLIO', params: { force: true } },
  ];

  for (const { tier, params } of TIERS) {
    it(`${tier} tier writes nothing to CurrencyRate and makes no external HTTP calls`, async () => {
      // If any forbidden op fires, the mock throws and this await rejects.
      await expect(
        generateTieredInsights('tenant-hygiene', tier, params),
      ).resolves.toBeDefined();
    });
  }

  // Helper: strip block (/* ... */) and line (// ...) comments from a source
  // string. The structural invariants below check for *actual usage*
  // (destructuring imports + call sites), not comment mentions — the
  // warning JSDoc in currencyService.js and the warning comment in
  // insightService.js both legitimately name the function so future devs
  // grepping for it land on the explanation.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid matching URLs)
  }

  it('insightService.js does not import getOrCreateCurrencyRate', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../services/insightService.js',
    );
    const src = stripComments(fs.readFileSync(sourcePath, 'utf8'));
    // Match destructuring imports: `{ ..., getOrCreateCurrencyRate, ... }`
    expect(src).not.toMatch(/\bgetOrCreateCurrencyRate\s*[,}]/);
    // Match call sites: `getOrCreateCurrencyRate(...)`
    expect(src).not.toMatch(/\bgetOrCreateCurrencyRate\s*\(/);
  });

  it('insightService.js does not import axios', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../services/insightService.js',
    );
    const src = stripComments(fs.readFileSync(sourcePath, 'utf8'));
    expect(src).not.toMatch(/require\(['"]axios['"]\)/);
  });
});
