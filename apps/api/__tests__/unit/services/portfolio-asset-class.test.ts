/**
 * Unit tests for the asset class classifier, ETF look-through and the
 * composition / fixed income aggregations in `@bliss/shared/portfolio`
 * (Equity Analysis #79). `packages/shared` has no test runner, so they are
 * tested here against the ESM build.
 *
 * ETF fixtures follow the #77 Twelve Data spike: /profile `type` values
 * ('Common Stock', 'REIT', 'ETF') and /etfs/world/composition for QQQ
 * (Technology 59.15%, empty country allocation).
 */

import { describe, it, expect } from 'vitest';
import {
  ASSET_CLASSES,
  EQUITY_ASSET_CLASSES,
  classifyAssetClass,
  isValidAssetClass,
  normalizeEtfComposition,
  lookThrough,
  buildComposition,
  buildFixedIncome,
  bondCouponPct,
  DIVERSIFIED,
  LOOK_THROUGH_OTHER,
  FIXED_INCOME_BUCKET,
} from '@bliss/shared/portfolio';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const QQQ_COMPOSITION = {
  sectors: [
    { sector: 'Technology', weight: 0.5915 },
    { sector: 'Communication Services', weight: 0.1581 },
    { sector: 'Consumer Cyclical', weight: 0.1304 },
    { sector: 'Healthcare', weight: 0.0452 },
    { sector: 'Consumer Defensive', weight: 0.0388 },
  ],
  countries: [],
  assetAllocation: { cash: 0.0005, stocks: 0.9995, preferred_stocks: 0, convertables: 0, bonds: 0, others: 0 },
};

const VWCE_COMPOSITION = {
  sectors: [
    { sector: 'Technology', weight: 0.2698 },
    { sector: 'Financial Services', weight: 0.1621 },
    { sector: 'Industrials', weight: 0.1085 },
  ],
  countries: [
    { country: 'United States', weight: 0.6284 },
    { country: 'Japan', weight: 0.0512 },
  ],
  assetAllocation: { stocks: 0.9968, cash: 0.0032, bonds: 0 },
};

const XLK_COMPOSITION = {
  sectors: [{ sector: 'Technology', weight: 0.9989 }],
  countries: [{ country: 'United States', weight: 1 }],
  assetAllocation: { stocks: 0.9989, cash: 0.0011, bonds: 0 },
};

const BND_COMPOSITION = {
  sectors: [],
  countries: [{ country: 'United States', weight: 0.94 }],
  assetAllocation: { stocks: 0, cash: 0.012, bonds: 0.988 },
};

const stock = { processingHint: 'API_STOCK', defaultCategoryCode: 'STOCKS', categoryGroup: 'Stocks' };
const fund = { processingHint: 'API_FUND', defaultCategoryCode: 'ETFS', categoryGroup: 'ETFs' };
const etf = (name: string, composition: unknown = null) => ({
  ...fund,
  security: { assetType: 'ETF', name, composition },
});
const cls = (input: Record<string, unknown>) => classifyAssetClass(input).assetClass;

// ─── classifyAssetClass ──────────────────────────────────────────────────────

describe('classifyAssetClass', () => {
  it('exposes the 12 asset classes', () => {
    expect(ASSET_CLASSES).toHaveLength(12);
    expect(EQUITY_ASSET_CLASSES).toEqual(['STOCK', 'REIT', 'INDEX_ETF', 'SECTOR_ETF']);
    expect(isValidAssetClass('REIT')).toBe(true);
    expect(isValidAssetClass('reit')).toBe(false);
    expect(isValidAssetClass(null)).toBe(false);
  });

  it('classifies the acceptance-criteria examples', () => {
    expect(cls({ ...stock, security: { assetType: 'Common Stock', name: 'Coca-Cola Co' } })).toBe('STOCK'); // KO
    expect(cls({ ...stock, security: { assetType: 'Preferred Stock', name: 'Itausa' } })).toBe('STOCK'); // ITSA4
    expect(cls({ ...stock, security: { assetType: 'REIT', name: 'Realty Income Corp' } })).toBe('REIT'); // O
    expect(cls({ ...fund, security: { assetType: 'REIT', name: 'CSHG Logística FII' } })).toBe('REIT'); // HGLG11
    expect(cls(etf('Invesco QQQ Trust', QQQ_COMPOSITION))).toBe('INDEX_ETF'); // QQQ, 59% tech
    expect(cls(etf('Vanguard FTSE All-World UCITS ETF', VWCE_COMPOSITION))).toBe('INDEX_ETF'); // VWCE
    expect(cls(etf('Technology Select Sector SPDR Fund', XLK_COMPOSITION))).toBe('SECTOR_ETF'); // XLK
    expect(cls(etf('Vanguard Total Bond Market ETF', BND_COMPOSITION))).toBe('BOND_ETF'); // BND
    expect(cls({ processingHint: 'API_FUND', defaultCategoryCode: 'INVESTMENT_FUNDS', security: { assetType: 'Mutual Fund' } })).toBe('FUND');
    expect(cls({ processingHint: 'MANUAL', defaultCategoryCode: 'GOVERNMENT_BONDS', incomeTerms: { issuerType: 'GOVERNMENT' } })).toBe('GOV_BOND');
    expect(cls({ processingHint: 'MANUAL', defaultCategoryCode: 'CORPORATE_BONDS' })).toBe('CORP_BOND');
    expect(cls({ processingHint: 'MANUAL', defaultCategoryCode: 'REAL_ESTATE' })).toBe('REAL_ESTATE');
    expect(cls({ processingHint: 'API_CRYPTO', defaultCategoryCode: 'CRYPTO' })).toBe('CRYPTO');
    expect(cls({ processingHint: 'CASH' })).toBe('CASH');
  });

  it('lets a valid override win over every rule', () => {
    expect(classifyAssetClass({ ...stock, override: 'FUND', security: { assetType: 'Common Stock' } }))
      .toEqual({ assetClass: 'FUND', source: 'OVERRIDE' });
    expect(classifyAssetClass({ processingHint: 'CASH', override: 'OTHER' }).assetClass).toBe('OTHER');
    expect(classifyAssetClass({ defaultCategoryCode: 'GOVERNMENT_BONDS', override: 'CORP_BOND' }).source).toBe('OVERRIDE');
  });

  it('ignores an invalid override', () => {
    expect(classifyAssetClass({ ...stock, override: 'BANANA' })).toEqual({ assetClass: 'STOCK', source: 'AUTO' });
    expect(classifyAssetClass({ ...stock, override: '' }).source).toBe('AUTO');
  });

  it('prefers the income terms issuer type over the bond category', () => {
    expect(cls({ defaultCategoryCode: 'GOVERNMENT_BONDS', incomeTerms: { issuerType: 'CORPORATE' } })).toBe('CORP_BOND');
    expect(cls({ defaultCategoryCode: 'CORPORATE_BONDS', incomeTerms: { issuerType: null } })).toBe('CORP_BOND');
    expect(cls({ processingHint: 'MANUAL', incomeTerms: { issuerType: 'GOVERNMENT' } })).toBe('GOV_BOND');
  });

  it('uses the Real Estate group for custom property categories', () => {
    expect(cls({ processingHint: 'MANUAL', categoryGroup: 'Real Estate' })).toBe('REAL_ESTATE');
  });

  it('keeps commodities (API_STOCK hint) out of STOCK', () => {
    expect(cls({ processingHint: 'API_STOCK', defaultCategoryCode: 'COMMODITIES' })).toBe('OTHER');
  });

  it('applies the composition thresholds at their boundaries', () => {
    const at = (largest: number, bonds: number) => cls(etf('Some ETF', {
      sectors: [{ sector: 'Technology', weight: largest }],
      assetAllocation: { stocks: 1 - bonds, bonds },
    }));
    expect(at(0.75, 0)).toBe('SECTOR_ETF');
    expect(at(0.7499, 0)).toBe('INDEX_ETF');
    expect(at(0.1, 0.5)).toBe('BOND_ETF');
    expect(at(0.1, 0.4999)).toBe('INDEX_ETF');
  });

  it('accepts percentage weights from the provider', () => {
    expect(cls(etf('XLK', { sectors: [{ sector: 'Technology', weight: 99.89 }], assetAllocation: { stocks: 99.9, bonds: 0 } })))
      .toBe('SECTOR_ETF');
    expect(cls(etf('AGG', { sectors: [], assetAllocation: { bonds: 97, cash: 3 } }))).toBe('BOND_ETF');
  });

  it('falls back to the name for bond ETFs without composition', () => {
    expect(cls(etf('iShares Core U.S. Aggregate Bond ETF'))).toBe('BOND_ETF');
    expect(cls(etf('iShares 20+ Year Treasury'))).toBe('BOND_ETF');
    expect(cls(etf('Vanguard UK Gilt UCITS ETF'))).toBe('BOND_ETF');
    expect(cls(etf('SPDR Portfolio Fixed Income'))).toBe('BOND_ETF');
    expect(cls(etf('Vanguard S&P 500 ETF'))).toBe('INDEX_ETF');
    expect(cls(etf(null as unknown as string))).toBe('INDEX_ETF');
  });

  it('ignores the name when composition says it is equity', () => {
    // A composition exists and shows no bonds → the name doesn't matter.
    expect(cls(etf('Bond Street Equity ETF', QQQ_COMPOSITION))).toBe('INDEX_ETF');
  });

  it('never uses the ETF profile sector', () => {
    expect(cls({ ...fund, security: { assetType: 'etf', name: 'X', sector: 'Technology' } })).toBe('INDEX_ETF');
  });

  it('falls back to OTHER', () => {
    expect(cls({ processingHint: 'MANUAL', defaultCategoryCode: 'COLLECTIBLE' })).toBe('OTHER');
    expect(cls({})).toBe('OTHER');
    expect(classifyAssetClass().assetClass).toBe('OTHER');
  });

  it('reaches every asset class', () => {
    const reached = new Set([
      cls({ ...stock }),
      cls(etf('QQQ', QQQ_COMPOSITION)),
      cls(etf('XLK', XLK_COMPOSITION)),
      cls(etf('BND', BND_COMPOSITION)),
      cls({ security: { assetType: 'REIT' } }),
      cls({ processingHint: 'API_FUND' }),
      cls({ defaultCategoryCode: 'GOVERNMENT_BONDS' }),
      cls({ defaultCategoryCode: 'CORPORATE_BONDS' }),
      cls({ defaultCategoryCode: 'REAL_ESTATE' }),
      cls({ processingHint: 'API_CRYPTO' }),
      cls({ processingHint: 'CASH' }),
      cls({}),
    ]);
    expect([...reached].sort()).toEqual([...ASSET_CLASSES].sort());
  });
});

// ─── normalizeEtfComposition ─────────────────────────────────────────────────

describe('normalizeEtfComposition', () => {
  it('returns null for missing input', () => {
    expect(normalizeEtfComposition(null)).toBeNull();
    expect(normalizeEtfComposition('x' as unknown as object)).toBeNull();
  });

  it('drops invalid entries, sorts by weight and scales an over-100% list', () => {
    const c = normalizeEtfComposition({
      sectors: [
        { sector: 'A', weight: 0.4 },
        { sector: 'B', weight: 0.8 },
        { sector: '', weight: 0.3 },
        { sector: 'C', weight: 0 },
        { sector: 'D', weight: 'x' },
      ],
      countries: 'bad',
    });
    expect(c.sectors.map((s: { sector: string }) => s.sector)).toEqual(['B', 'A']);
    expect(c.sectors[0].weight + c.sectors[1].weight).toBeCloseTo(1);
    expect(c.countries).toEqual([]);
    expect(c.assetAllocation).toEqual({});
  });
});

// ─── lookThrough ─────────────────────────────────────────────────────────────

describe('lookThrough', () => {
  const qqq = { value: 10000, assetClass: 'INDEX_ETF', isEtf: true, composition: QQQ_COMPOSITION, sector: DIVERSIFIED, country: DIVERSIFIED };
  const ko = { value: 5000, assetClass: 'STOCK', sector: 'Consumer Defensive', country: 'United States', industry: 'Beverages' };
  const bnd = { value: 2000, assetClass: 'BOND_ETF', isEtf: true, composition: BND_COMPOSITION };
  const byName = (groups: Array<{ name: string; value: number }>) =>
    Object.fromEntries(groups.map((g) => [g.name, g.value]));

  it('adds 59.15% of a QQQ holding to Technology', () => {
    const groups = byName(lookThrough([qqq], 'sector'));
    expect(groups.Technology).toBeCloseTo(5915);
  });

  it('puts the share not covered by sector weights in "Other"', () => {
    const groups = byName(lookThrough([qqq], 'sector'));
    const covered = QQQ_COMPOSITION.sectors.reduce((s, x) => s + x.weight, 0);
    expect(groups[LOOK_THROUGH_OTHER]).toBeCloseTo(10000 * (1 - covered));
    const total = Object.values(groups).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(10000);
  });

  it('merges look-through with direct stock holdings and records contributions', () => {
    const groups = lookThrough([qqq, ko], 'sector');
    const defensive = groups.find((g: { name: string }) => g.name === 'Consumer Defensive');
    expect(defensive.value).toBeCloseTo(5000 + 388);
    expect(defensive.holdings.map((h: { index: number }) => h.index).sort()).toEqual([0, 1]);
    expect(groups[0].name).toBe('Technology'); // largest first
  });

  it('uses the country allocation, or "Diversified" when it is empty', () => {
    const vwce = { value: 1000, assetClass: 'INDEX_ETF', isEtf: true, composition: VWCE_COMPOSITION };
    const groups = byName(lookThrough([qqq, vwce, ko], 'country'));
    expect(groups[DIVERSIFIED]).toBeCloseTo(10000); // QQQ has no country allocation
    expect(groups['United States']).toBeCloseTo(5000 + 628.4);
    expect(groups.Japan).toBeCloseTo(51.2);
    expect(groups[LOOK_THROUGH_OTHER]).toBeCloseTo(1000 * (1 - 0.6284 - 0.0512));
  });

  it('keeps ETFs without composition as "Diversified"', () => {
    const groups = byName(lookThrough([{ value: 300, assetClass: 'INDEX_ETF', isEtf: true, composition: null }], 'sector'));
    expect(groups).toEqual({ [DIVERSIFIED]: 300 });
  });

  it('never looks through by industry', () => {
    const groups = byName(lookThrough([qqq, ko], 'industry'));
    expect(groups).toEqual({ [DIVERSIFIED]: 10000, Beverages: 5000 });
  });

  it('keeps bond ETFs out of equity sectors', () => {
    expect(byName(lookThrough([bnd], 'sector'))).toEqual({ [FIXED_INCOME_BUCKET]: 2000 });
    expect(byName(lookThrough([bnd], 'country'))).toEqual({ [FIXED_INCOME_BUCKET]: 2000 });
    expect(byName(lookThrough([bnd], 'industry'))).toEqual({ [DIVERSIFIED]: 2000 });
  });

  it('skips non-equity holdings and non-positive values', () => {
    const groups = lookThrough([
      { value: 1000, assetClass: 'GOV_BOND' },
      { value: 1000, assetClass: 'REAL_ESTATE' },
      { value: 0, assetClass: 'STOCK', sector: 'X' },
      { value: '250', assetClass: 'REIT', sector: 'Real Estate' },
      { value: 100, assetClass: 'STOCK' },
    ], 'sector');
    expect(byName(groups)).toEqual({ 'Real Estate': 250, Unknown: 100 });
  });

  it('with the toggle off, shows every ETF as one "Diversified" bucket (#77 behaviour)', () => {
    const groups = byName(lookThrough([qqq, ko, bnd, { value: 50, assetClass: 'GOV_BOND' }], 'sector', { enabled: false }));
    expect(groups).toEqual({ [DIVERSIFIED]: 12000, 'Consumer Defensive': 5000 });
  });

  it('defaults to an empty list', () => {
    expect(lookThrough()).toEqual([]);
  });
});

// ─── buildComposition ────────────────────────────────────────────────────────

describe('buildComposition', () => {
  it('sums value and count per class with percentages', () => {
    const rows = buildComposition([
      { assetClass: 'STOCK', value: 3000 },
      { assetClass: 'STOCK', value: 1000 },
      { assetClass: 'INDEX_ETF', value: 5000 },
      { assetClass: 'GOV_BOND', value: 1000 },
      { assetClass: 'CRYPTO', value: 0 },
      { assetClass: 'NOPE', value: 100 },
    ]);
    expect(rows).toEqual([
      { assetClass: 'INDEX_ETF', value: 5000, count: 1, percent: 50 },
      { assetClass: 'STOCK', value: 4000, count: 2, percent: 40 },
      { assetClass: 'GOV_BOND', value: 1000, count: 1, percent: 10 },
    ]);
  });

  it('is empty without items', () => {
    expect(buildComposition()).toEqual([]);
  });
});

// ─── buildFixedIncome ────────────────────────────────────────────────────────

describe('buildFixedIncome', () => {
  const asOf = '2026-01-01';

  it('returns null without bonds', () => {
    expect(buildFixedIncome([], { asOf })).toBeNull();
    expect(buildFixedIncome([{ assetClass: 'STOCK', face: 100 }], { asOf })).toBeNull();
    expect(buildFixedIncome([{ assetClass: 'GOV_BOND', face: 0 }], { asOf })).toBeNull();
    expect(buildFixedIncome()).toBeNull();
  });

  it('computes totals, face-weighted coupon and maturity and the gov/corp split', () => {
    const fi = buildFixedIncome([
      { assetClass: 'GOV_BOND', face: 30000, couponPct: 4, maturityDate: '2031-01-01' },
      { assetClass: 'CORP_BOND', face: 10000, couponPct: 6, maturityDate: new Date('2028-01-01') },
    ], { asOf });
    expect(fi.totalFace).toBe(40000);
    expect(fi.weightedCouponPct).toBe(4.5);
    expect(fi.avgYearsToMaturity).toBeCloseTo((30000 * 5 + 10000 * 2) / 40000, 1);
    expect(fi.governmentPct).toBe(75);
    expect(fi.corporatePct).toBe(25);
    expect(fi.count).toBe(2);
  });

  it('leaves coupon / maturity null when unknown and clamps matured bonds at zero', () => {
    const fi = buildFixedIncome([{ assetClass: 'CORP_BOND', face: 100, couponPct: null, maturityDate: null }], { asOf });
    expect(fi.weightedCouponPct).toBeNull();
    expect(fi.avgYearsToMaturity).toBeNull();
    expect(fi.corporatePct).toBe(100);
    const matured = buildFixedIncome([{ assetClass: 'GOV_BOND', face: 100, couponPct: 5, maturityDate: '2020-01-01' }], { asOf });
    expect(matured.avgYearsToMaturity).toBe(0);
  });
});

describe('bondCouponPct', () => {
  it('derives the current rate per income type', () => {
    expect(bondCouponPct(null)).toBeNull();
    expect(bondCouponPct({ incomeType: 'FIXED_COUPON', couponRate: 5.25 })).toBe(5.25);
    expect(bondCouponPct({ incomeType: 'FLOATING_COUPON', assumedIndexRate: 10.5, spread: 1 })).toBe(11.5);
    expect(bondCouponPct({ incomeType: 'FLOATING_COUPON' })).toBeNull();
    expect(bondCouponPct({ incomeType: 'INFLATION_LINKED', couponRate: '6', assumedIndexRate: '4.5' })).toBe(10.5);
    expect(bondCouponPct({ incomeType: 'INFLATION_LINKED' })).toBeNull();
    expect(bondCouponPct({ incomeType: 'NONE', couponRate: 3 })).toBe(3);
  });
});
