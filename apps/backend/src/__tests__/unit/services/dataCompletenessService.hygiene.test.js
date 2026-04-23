/**
 * Hygiene test for dataCompletenessService.
 *
 * `PortfolioItem` has no `ticker` column — the ticker symbol lives in the
 * (non-nullable) `symbol` field. `ticker` only exists on the `Transaction`
 * model. A reference to `portfolioItem.ticker` crashes Prisma with
 * `Unknown argument \`ticker\`` and broke the weekly portfolio insights cron
 * on 2026-04-20 (see `checkPortfolioTierCompleteness`).
 *
 * Two invariants guarded here:
 *   1. Source-level: the file never references `portfolioItem`-scoped
 *      `ticker` usage (as a Prisma where/select/field path).
 *   2. Runtime: `checkPortfolioTierCompleteness` resolves cleanly against a
 *      Prisma mock that would throw on any unexpected argument.
 *
 * The equivalent guard for `insightService.js` lives in
 * `insightService.hygiene.test.js`. Keep them in sync.
 */

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Prisma mock that enforces the real `PortfolioItem` column set. Any query
// that references a field outside this list throws — mirroring what Prisma
// does at runtime when you pass `ticker: { not: null }`.
//
// Jest requires mock factory functions to not reference out-of-scope
// variables (except those prefixed with `mock`), so everything the factory
// needs is defined inline below.
jest.mock('../../../../prisma/prisma.js', () => {
  const PORTFOLIO_ITEM_COLUMNS = new Set([
    'id',
    'tenantId',
    'categoryId',
    'symbol',
    'currency',
    'source',
    'isin',
    'exchange',
    'assetCurrency',
    'costBasis',
    'realizedPnL',
    'quantity',
    'currentValue',
    'totalInvested',
    'costBasisInUSD',
    'currentValueInUSD',
    'realizedPnLInUSD',
    'totalInvestedInUSD',
    'createdAt',
    'updatedAt',
    'category',
    'transactions',
    'valueHistory',
    'manualValues',
    'holdings',
    'debtTerms',
    'tenant',
    // Prisma logical operators
    'AND',
    'OR',
    'NOT',
  ]);

  const assertKnownKeys = (obj, path) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (!PORTFOLIO_ITEM_COLUMNS.has(key)) {
        throw new Error(
          `Unknown argument \`${key}\` on PortfolioItem (path: ${path}). ` +
            `Available: ${[...PORTFOLIO_ITEM_COLUMNS].join(', ')}`,
        );
      }
    }
  };

  return {
    portfolioItem: {
      count: jest.fn((args = {}) => {
        assertKnownKeys(args.where, 'where');
        return Promise.resolve(2);
      }),
      findMany: jest.fn((args = {}) => {
        assertKnownKeys(args.where, 'where');
        assertKnownKeys(args.select, 'select');
        return Promise.resolve([{ symbol: 'AAPL' }, { symbol: 'VWCE.DEX' }]);
      }),
    },
    securityMaster: {
      count: jest.fn().mockResolvedValue(1),
    },
    // Other models are unused by checkPortfolioTierCompleteness. If this
    // function ever grows to touch more models, add fail-loud stubs here.
    analyticsCacheMonthly: { findMany: jest.fn().mockResolvedValue([]) },
    transaction: { count: jest.fn().mockResolvedValue(0) },
    portfolioValueHistory: { groupBy: jest.fn().mockResolvedValue([]) },
  };
});

// ─── Imports after mocks ────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const {
  checkPortfolioTierCompleteness,
} = require('../../../services/dataCompletenessService');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('dataCompletenessService — portfolio tier hygiene', () => {
  it('checkPortfolioTierCompleteness resolves without unknown-argument errors', async () => {
    const result = await checkPortfolioTierCompleteness('tenant-hygiene');
    expect(result).toBeDefined();
    expect(result).toHaveProperty('holdingsCount');
    expect(result).toHaveProperty('securityMasterCount');
    expect(result).toHaveProperty('tickers');
    expect(result.tickers).toEqual(expect.arrayContaining(['AAPL', 'VWCE.DEX']));
  });

  // Helper: strip block (/* ... */) and line (// ...) comments from a source
  // string. We want to match *actual usage* (Prisma field paths), not
  // comment mentions — the fix comment in the file legitimately names the
  // phantom `ticker` column so future readers understand the context.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid matching URLs)
  }

  it('dataCompletenessService.js does not reference portfolioItem.ticker as a Prisma field', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../services/dataCompletenessService.js',
    );
    const src = stripComments(fs.readFileSync(sourcePath, 'utf8'));

    // Guard 1: no `ticker:` key in a Prisma where/select. This catches
    // `ticker: { not: null }`, `ticker: true`, `ticker: "AAPL"`, etc.
    //
    // We scope the search to the checkPortfolioTierCompleteness function body
    // so we don't accidentally flag unrelated constructs.
    const fnMatch = src.match(
      /async\s+function\s+checkPortfolioTierCompleteness[\s\S]*?\n\}\n/,
    );
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];
    expect(fnBody).not.toMatch(/\bticker\s*:/);

    // Guard 2: no `.ticker` property access on results of this function's
    // Prisma queries. Anywhere that used to do `h.ticker` should now do
    // `h.symbol`. This catches silent regressions where the Prisma mock
    // stays happy but the mapping is wrong.
    expect(fnBody).not.toMatch(/\.ticker\b/);
  });
});
