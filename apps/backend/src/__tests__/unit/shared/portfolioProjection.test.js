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
