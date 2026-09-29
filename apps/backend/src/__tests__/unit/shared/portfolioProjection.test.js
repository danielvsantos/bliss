/**
 * @bliss/shared/portfolio from the backend (CJS) — Passive Income #77.
 *
 * #80's insights will `require('@bliss/shared/portfolio').project()`, so this
 * checks the CJS build loads and returns exactly what the ESM build (used by
 * the API) returns for the same fixture.
 */
const { execFileSync } = require('child_process');
const shared = require('@bliss/shared/portfolio');

const FIXTURE = {
  asOf: '2026-09-27',
  horizon: 24,
  displayCurrency: 'USD',
  assets: [
    {
      id: 1, label: 'KO · IBKR', symbol: 'KO', accountName: 'IBKR', assetClass: 'STOCK', quantity: 100, currentValue: 7000, fxRate: 1,
      recentDividends: [
        { exDate: '2026-09-15', amount: 0.53 }, { exDate: '2026-06-13', amount: 0.51 },
        { exDate: '2026-03-14', amount: 0.51 }, { exDate: '2025-11-29', amount: 0.51 },
      ],
    },
    {
      id: 3, label: 'KO · XP', symbol: 'KO', accountName: 'XP', assetClass: 'STOCK', quantity: 20, currentValue: 1400, fxRate: 1,
      recentDividends: [{ exDate: '2026-09-15', amount: 0.53 }],
    },
    {
      id: 2, label: 'Bond', assetClass: 'BOND', quantity: 10, currentValue: 10000, fxRate: 1,
      terms: { incomeType: 'FIXED_COUPON', faceValuePerUnit: 1000, couponRate: 5, frequency: 'SEMIANNUAL', maturityDate: '2027-06-15' },
    },
  ],
  streams: [
    { id: 9, name: 'Pension', fxRate: 1, terms: { incomeType: 'FIXED_AMOUNT', amountPerPayment: 500, frequency: 'MONTHLY', startDate: '2026-01-05' } },
  ],
};

describe('@bliss/shared/portfolio (CJS build)', () => {
  it('exports project() and the constants', () => {
    expect(typeof shared.project).toBe('function');
    expect(typeof shared.groupItems).toBe('function');
    expect(shared.PAYMENT_LAG_DAYS).toBe(14);
    expect(shared.INCOME_TYPES).toHaveLength(9);
  });

  it('returns the same projection as the ESM build', () => {
    const cjs = shared.project(FIXTURE);
    const script = `import { project } from '@bliss/shared/portfolio';
      process.stdout.write(JSON.stringify(project(${JSON.stringify(FIXTURE)})));`;
    const esm = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: __dirname,
      encoding: 'utf8',
    }));
    expect(cjs).toEqual(esm);
    expect(cjs.totals.next12mIncome).toBeGreaterThan(0);
    // Grouped view (#83): KO held in two accounts is one group.
    expect(cjs.groups).toEqual(esm.groups);
    expect(cjs.groups.find((g) => g.groupKey === 'KO').accountCount).toBe(2);
  });
});

// Equity Analysis #79 — #80's insights require these from the CJS build.
const CLASSIFY_FIXTURES = [
  { processingHint: 'API_STOCK', security: { assetType: 'Common Stock' } },
  { processingHint: 'API_STOCK', security: { assetType: 'REIT' } },
  { processingHint: 'API_FUND', security: { assetType: 'ETF', composition: { sectors: [{ sector: 'Technology', weight: 0.5915 }] } } },
  { processingHint: 'API_FUND', security: { assetType: 'ETF', name: 'Vanguard Total Bond Market' } },
  { defaultCategoryCode: 'GOVERNMENT_BONDS', incomeTerms: { issuerType: 'CORPORATE' } },
  { override: 'FUND', processingHint: 'API_STOCK' },
];
const LOOK_THROUGH_FIXTURE = [
  { value: 1000, assetClass: 'INDEX_ETF', isEtf: true, composition: { sectors: [{ sector: 'Technology', weight: 0.5915 }] } },
  { value: 500, assetClass: 'STOCK', sector: 'Consumer Defensive' },
];

describe('@bliss/shared/portfolio asset class helpers (CJS build)', () => {
  it('exports the classifier, look-through and aggregation helpers', () => {
    expect(shared.ASSET_CLASSES).toHaveLength(12);
    for (const fn of ['classifyAssetClass', 'lookThrough', 'buildComposition', 'buildFixedIncome', 'normalizeEtfComposition']) {
      expect(typeof shared[fn]).toBe('function');
    }
  });

  it('classifies and looks through exactly like the ESM build', () => {
    const cjs = {
      classes: CLASSIFY_FIXTURES.map((f) => shared.classifyAssetClass(f)),
      groups: shared.lookThrough(LOOK_THROUGH_FIXTURE, 'sector'),
    };
    const script = `import { classifyAssetClass, lookThrough } from '@bliss/shared/portfolio';
      process.stdout.write(JSON.stringify({
        classes: ${JSON.stringify(CLASSIFY_FIXTURES)}.map((f) => classifyAssetClass(f)),
        groups: lookThrough(${JSON.stringify(LOOK_THROUGH_FIXTURE)}, 'sector'),
      }));`;
    const esm = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: __dirname,
      encoding: 'utf8',
    }));
    expect(cjs).toEqual(esm);
    expect(cjs.classes.map((c) => c.assetClass)).toEqual(['STOCK', 'REIT', 'INDEX_ETF', 'BOND_ETF', 'CORP_BOND', 'FUND']);
    expect(cjs.groups.find((g) => g.name === 'Technology').value).toBeCloseTo(591.5);
  });
});

describe('@bliss/shared/portfolio Manage Assets helpers (#81)', () => {
  const { resolveIncomeSource, MANUAL_PRICE_STALE_DAYS, MANUAL_PRICE_WARNING_DAYS, MANUAL_PRICE_CRITICAL_DAYS } = shared;

  it('exports the manual price staleness thresholds', () => {
    expect([MANUAL_PRICE_STALE_DAYS, MANUAL_PRICE_WARNING_DAYS, MANUAL_PRICE_CRITICAL_DAYS]).toEqual([30, 60, 90]);
  });

  it('resolveIncomeSource follows the projection priority', () => {
    expect(resolveIncomeSource({ assetClass: 'STOCK', terms: null, recentDividends: [{ exDate: '2026-01-01', amount: 1 }] })).toBe('AUTO');
    expect(resolveIncomeSource({ assetClass: 'ETF', terms: null, recentDividends: [] })).toBe('AUTO');
    expect(resolveIncomeSource({ assetClass: 'STOCK', terms: { incomeType: 'DIVIDEND', dividendPerUnit: '1.9' }, recentDividends: [] })).toBe('OVERRIDE');
    expect(resolveIncomeSource({ assetClass: 'FUND', terms: { incomeType: 'DIVIDEND', dividendPerUnit: '1.9' } })).toBe('MANUAL');
    expect(resolveIncomeSource({ assetClass: 'BOND', terms: { incomeType: 'FIXED_COUPON' } })).toBe('MANUAL');
    expect(resolveIncomeSource({ assetClass: 'STOCK', terms: { incomeType: 'DIVIDEND', isDistributing: false } })).toBe('MANUAL');
    expect(resolveIncomeSource({ assetClass: 'STOCK', terms: null, recentDividends: null })).toBe('MISSING');
    expect(resolveIncomeSource()).toBe('MISSING');
  });
});
