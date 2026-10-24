/**
 * Unit tests for the eToro copy-trade look-through in `@bliss/shared/portfolio`
 * (#143): holding merge, composition derivation, and how a COPY_TRADE holding
 * flows through `lookThrough()` and the passive income classifier.
 * `packages/shared` has no test runner, so they are tested here against the
 * ESM build.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeCopyHoldings,
  deriveCopyComposition,
  explodeCopyHoldings,
  lookThrough,
  classifyIncomeAsset,
  DIVERSIFIED,
  LOOK_THROUGH_OTHER,
  FIXED_INCOME_BUCKET,
} from '@bliss/shared/portfolio';
import { mapEtoroInstrument } from '@bliss/shared/etoro';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SECURITIES = new Map<string, Record<string, unknown>>([
  ['AMZN', { assetType: 'Common Stock', sector: 'Consumer Cyclical', country: 'United States', peRatio: '40', earningsTrusted: true, dividendYield: 0, dividendTrusted: true }],
  ['MSFT', { assetType: 'Common Stock', sector: 'Technology', country: 'United States', peRatio: 30, earningsTrusted: true, dividendYield: 0.008, dividendTrusted: true }],
  ['AIR', { assetType: 'Common Stock', sector: 'Industrials', country: 'France', peRatio: 25, earningsTrusted: false, dividendYield: 0.012, dividendTrusted: true }],
  ['O', { assetType: 'REIT', sector: 'Real Estate', country: 'United States', peRatio: 50, earningsTrusted: true, dividendYield: 0.055, dividendTrusted: true }],
  ['QQQ', {
    assetType: 'ETF',
    name: 'Invesco QQQ Trust',
    etfComposition: {
      sectors: [{ sector: 'Technology', weight: 0.6 }, { sector: 'Communication Services', weight: 0.2 }],
      countries: [{ country: 'United States', weight: 0.97 }],
      assetAllocation: { stocks: 1, bonds: 0 },
    },
    dividendYield: 0.006,
    dividendTrusted: true,
    peRatio: 35,
    earningsTrusted: true,
  }],
  ['BND', {
    assetType: 'ETF',
    name: 'Vanguard Total Bond Market ETF',
    etfComposition: { sectors: [], countries: [], assetAllocation: { bonds: 0.99, cash: 0.01 } },
  }],
  ['VT', { assetType: 'ETF', name: 'Vanguard Total World Stock ETF', etfComposition: null }],
]);

/** Holdings as the sync stores them: mapped listing + share of the copy's value (0–100). */
const holding = (symbolFull: string, exchangeID: number, valuePct: number, instrumentTypeID = 5) => ({
  ...mapEtoroInstrument({ symbolFull, exchangeID, instrumentTypeID }),
  valuePct,
});

const COPY = {
  holdings: [
    holding('AMZN', 4, 15),
    holding('AMZN.RTH', 33, 5),
    holding('MSFT', 4, 20),
    holding('AIR.PA', 9, 10),
    holding('O', 5, 5),
    holding('QQQ', 4, 20, 6),
    holding('BND', 4, 5, 6),
    holding('VT', 5, 5, 6),
    holding('EMAAR.AE', 99, 5), // unknown exchange → unresolved
  ],
  cashPct: 10,
};

// ─── mergeCopyHoldings ───────────────────────────────────────────────────────

describe('mergeCopyHoldings', () => {
  it('folds AMZN.RTH into the Nasdaq AMZN line', () => {
    const { holdings } = mergeCopyHoldings([holding('AMZN', 4, 15), holding('AMZN.RTH', 33, 5)]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ symbol: 'AMZN', exchange: 'XNAS', valuePct: 20 });
  });

  it('keeps an RTH variant on its own when the copy has no US sibling', () => {
    const { holdings } = mergeCopyHoldings([holding('TSLA.RTH', 33, 7)]);
    expect(holdings).toEqual([{ symbol: 'TSLA', exchange: null, type: 'STOCK', nonEquity: null, valuePct: 7, instrumentIds: [] }]);
  });

  it('merges two RTH variants of the same symbol', () => {
    const { holdings } = mergeCopyHoldings([holding('TSLA.RTH', 33, 7), holding('TSLA.RTH', 33, 3)]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].valuePct).toBe(10);
  });

  it('merges non-equity holdings by kind and symbol, never with a listing', () => {
    const { holdings } = mergeCopyHoldings([holding('BTC', 8, 3, 10), holding('BTC', 8, 2, 10), holding('GOLD', 2, 4, 2)]);
    expect(holdings.map((h: { symbol: string; nonEquity: string; valuePct: number }) => [h.symbol, h.nonEquity, h.valuePct]))
      .toEqual([['BTC', 'CRYPTO', 5], ['GOLD', 'COMMODITY', 4]]);
  });

  it('keeps ASML and ASML.NV as two listings', () => {
    const { holdings } = mergeCopyHoldings([holding('ASML', 4, 4), holding('ASML.NV', 30, 6)]);
    expect(holdings.map((h: { exchange: string }) => h.exchange)).toEqual(['XAMS', 'XNAS']);
  });

  it('collects instrument ids, sums unresolved holdings and drops non-positive ones', () => {
    const result = mergeCopyHoldings([
      { symbol: 'MSFT', exchange: 'XNAS', valuePct: 5, instrumentId: 1 },
      { symbol: 'msft', exchange: 'XNAS', valuePct: '5', instrumentId: 2 },
      { unresolved: true, valuePct: 3 },
      { symbol: 'X', exchange: 'XNAS', valuePct: 0 },
      { symbol: '', exchange: 'XNAS', valuePct: 1 },
    ]);
    expect(result.holdings).toEqual([{ symbol: 'MSFT', exchange: 'XNAS', type: null, nonEquity: null, valuePct: 10, instrumentIds: [1, 2] }]);
    expect(result.unmappedPct).toBe(4);
  });

  it('defaults to an empty result', () => {
    expect(mergeCopyHoldings()).toEqual({ holdings: [], unmappedPct: 0 });
    expect(mergeCopyHoldings(null as unknown as [])).toEqual({ holdings: [], unmappedPct: 0 });
  });
});

// ─── deriveCopyComposition ───────────────────────────────────────────────────

describe('deriveCopyComposition', () => {
  const byName = (list: Array<Record<string, unknown>>, key: string) =>
    Object.fromEntries(list.map((e) => [e[key], e.weight as number]));

  it('splits stocks by their own sector and ETFs by their composition weights', () => {
    const c = deriveCopyComposition(COPY, SECURITIES);
    const sectors = byName(c.sectors, 'sector');
    expect(sectors.Technology).toBeCloseTo(0.20 + 0.20 * 0.6);         // MSFT + QQQ
    expect(sectors['Consumer Cyclical']).toBeCloseTo(0.20);             // AMZN + AMZN.RTH
    expect(sectors['Communication Services']).toBeCloseTo(0.20 * 0.2);  // QQQ
    expect(sectors.Industrials).toBeCloseTo(0.10);                      // AIR
    expect(sectors['Real Estate']).toBeCloseTo(0.05);                   // O (REIT)
    expect(sectors[FIXED_INCOME_BUCKET]).toBeCloseTo(0.05);             // BND
    expect(c.sectors[0].sector).toBe('Technology');                     // largest first
  });

  it('splits by country the same way', () => {
    const countries = byName(deriveCopyComposition(COPY, SECURITIES).countries, 'country');
    expect(countries['United States']).toBeCloseTo(0.20 + 0.20 + 0.05 + 0.20 * 0.97);
    expect(countries.France).toBeCloseTo(0.10);
    expect(countries[FIXED_INCOME_BUCKET]).toBeCloseTo(0.05);
  });

  it('gives the asset-class mix, with cash and unmapped holdings', () => {
    const mix = byName(deriveCopyComposition(COPY, SECURITIES).assetClassMix, 'assetClass');
    expect(mix).toEqual({
      STOCK: 0.5, // AMZN (+RTH), MSFT, AIR
      INDEX_ETF: 0.25, // QQQ + VT
      REIT: 0.05,
      BOND_ETF: 0.05,
      CASH: 0.10,
      OTHER: 0.05,
    });
    const total = Object.values(mix).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1);
  });

  it('reports coverage and the unmapped share', () => {
    const c = deriveCopyComposition(COPY, SECURITIES);
    expect(c.unmappedPct).toBe(5);
    // Not covered by sectors: VT (no composition), QQQ's 20% remainder, cash, unmapped.
    expect(c.sectorCoveragePct).toBeCloseTo(100 - 5 - 20 * 0.2 - 10 - 5);
    expect(c.countryCoveragePct).toBeCloseTo(100 - 5 - 20 * 0.03 - 10 - 5);
  });

  it('value-weights P/E over trusted stocks only, and yield over trusted data', () => {
    const c = deriveCopyComposition(COPY, SECURITIES);
    // AMZN 20% @40, MSFT 20% @30. AIR is untrusted; O is a REIT; QQQ is an ETF.
    expect(c.peRatio).toBeCloseTo(35);
    expect(c.peCoverage).toBe(40);
    // AMZN 0, MSFT 0.008, AIR 0.012, O 0.055, QQQ 0.006 over 75% of the copy.
    const expectedYield = (0.2 * 0 + 0.2 * 0.008 + 0.1 * 0.012 + 0.05 * 0.055 + 0.2 * 0.006) / 0.75;
    expect(c.dividendYield).toBeCloseTo(expectedYield, 6);
    expect(c.yieldCoverage).toBe(75);
  });

  it('puts crypto and commodities in the asset-class mix only', () => {
    const c = deriveCopyComposition(
      { holdings: [holding('MSFT', 4, 50), holding('BTC', 8, 30, 10), holding('GOLD', 2, 20, 2)] },
      // A SecurityMaster row that happens to share a crypto ticker is never used.
      new Map([...SECURITIES, ['BTC', { assetType: 'Common Stock', sector: 'Financial Services', country: 'United States' }]]),
    );
    expect(byName(c.assetClassMix, 'assetClass')).toEqual({ STOCK: 0.5, CRYPTO: 0.3, OTHER: 0.2 });
    expect(c.sectors).toEqual([{ sector: 'Technology', weight: 0.5 }]);
    expect(c.unmappedPct).toBe(0);
  });

  it('leaves holdings without SecurityMaster data out of the split', () => {
    const c = deriveCopyComposition({ holdings: [holding('NEWCO', 4, 60), holding('MSFT', 4, 40)] }, SECURITIES);
    expect(c.sectors).toEqual([{ sector: 'Technology', weight: 0.4 }]);
    expect(c.assetClassMix).toEqual([{ assetClass: 'STOCK', weight: 1 }]);
    expect(c.peRatio).toBe(30);
    expect(c.peCoverage).toBe(40);
  });

  it('accepts a plain object keyed by symbol', () => {
    const c = deriveCopyComposition({ holdings: [holding('MSFT', 4, 100)] }, { MSFT: SECURITIES.get('MSFT') });
    expect(c.sectors).toEqual([{ sector: 'Technology', weight: 1 }]);
  });

  it('scales a copy whose shares add up past 100% back to 100%', () => {
    const c = deriveCopyComposition({ holdings: [holding('MSFT', 4, 80)], cashPct: 40 }, SECURITIES);
    expect(byName(c.assetClassMix, 'assetClass')).toEqual({ STOCK: 0.666667, CASH: 0.333333 });
  });

  it('returns an empty composition for an empty copy', () => {
    expect(deriveCopyComposition()).toEqual({
      sectors: [],
      countries: [],
      assetClassMix: [],
      peRatio: null,
      dividendYield: null,
      peCoverage: 0,
      yieldCoverage: 0,
      sectorCoveragePct: 0,
      countryCoveragePct: 0,
      unmappedPct: 0,
    });
  });
});

// ─── Copy rows in lookThrough() ──────────────────────────────────────────────

describe('lookThrough with a COPY_TRADE holding', () => {
  const composition = deriveCopyComposition(COPY, SECURITIES);
  const copyRow = { value: 10000, assetClass: 'COPY_TRADE', composition };
  const byName = (groups: Array<{ name: string; value: number }>) =>
    Object.fromEntries(groups.map((g) => [g.name, g.value]));

  it('splits the copy across sectors and the parts add up to its value', () => {
    const groups = byName(lookThrough([copyRow], 'sector'));
    expect(groups.Technology).toBeCloseTo(3200);
    expect(groups['Consumer Cyclical']).toBeCloseTo(2000);
    const total = Object.values(groups).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(10000, 2);
    // Everything not covered (VT, QQQ remainder, cash, unmapped) is "Other".
    expect(groups[LOOK_THROUGH_OTHER]).toBeCloseTo(10000 * (1 - composition.sectorCoveragePct / 100));
  });

  it('splits the copy across countries', () => {
    const groups = byName(lookThrough([copyRow], 'country'));
    expect(groups['United States']).toBeCloseTo(10000 * (0.45 + 0.2 * 0.97));
    expect(groups.France).toBeCloseTo(1000);
  });

  it('is one "Diversified" bucket with look-through off, and in the industry view', () => {
    expect(byName(lookThrough([copyRow], 'sector', { enabled: false }))).toEqual({ [DIVERSIFIED]: 10000 });
    expect(byName(lookThrough([copyRow], 'industry'))).toEqual({ [DIVERSIFIED]: 10000 });
  });

  it('is "Diversified" while the copy is not linked (no composition)', () => {
    expect(byName(lookThrough([{ value: 500, assetClass: 'COPY_TRADE', composition: null }], 'sector')))
      .toEqual({ [DIVERSIFIED]: 500 });
  });
});

// ─── Passive income (R19) ────────────────────────────────────────────────────

describe('classifyIncomeAsset for Copy Trading', () => {
  it('projects no cash income: dividends are paid inside the copy', () => {
    expect(classifyIncomeAsset({
      type: 'Investments',
      group: 'Funds',
      processingHint: 'COPY_TRADING',
      defaultCategoryCode: 'COPY_TRADING',
    })).toBeNull();
  });
});

describe('explodeCopyHoldings', () => {
  it('splits a copy into its positions, cash and the unidentified rest; weights add up to 1', () => {
    const positions = explodeCopyHoldings({
      holdings: [
        { symbol: 'MSFT', exchange: 'XNAS', type: 'STOCK', valuePct: 40 },
        { symbol: 'MSFT', exchange: null, usVariant: true, type: 'STOCK', valuePct: 10 },
        { symbol: 'BTC', nonEquity: 'CRYPTO', valuePct: 15 },
        { unresolved: true, valuePct: 5 },
      ],
      cashPct: 20,
    }, SECURITIES);
    expect(positions.map((p) => [p.kind, p.symbol, p.assetClass, p.weight])).toEqual([
      ['SECURITY', 'MSFT', 'STOCK', 0.5],
      ['CASH', null, 'CASH', 0.2],
      ['INSTRUMENT', 'BTC', 'CRYPTO', 0.15],
      // 5% unresolved + 10% eToro left unaccounted for
      ['UNMAPPED', null, 'OTHER', 0.15],
    ]);
    expect(positions[0].security).toBe(SECURITIES.get('MSFT'));
  });

  it('scales a copy that adds up past 100% and marks ETFs', () => {
    const positions = explodeCopyHoldings({
      holdings: [{ symbol: 'VWCE', exchange: 'XETR', type: 'ETF', valuePct: 60 }, { symbol: 'AMZN', exchange: 'XNAS', type: 'STOCK', valuePct: 60 }],
      cashPct: 0,
    }, SECURITIES);
    expect(positions.map((p) => p.weight)).toEqual([0.5, 0.5]);
    expect(positions.find((p) => p.symbol === 'VWCE')?.isEtf).toBe(true);
    expect(positions.some((p) => p.kind === 'UNMAPPED')).toBe(false);
  });

  it('gives the same sector totals as deriveCopyComposition', () => {
    const copy = {
      holdings: [
        { symbol: 'MSFT', exchange: 'XNAS', type: 'STOCK', valuePct: 50 },
        { symbol: 'AMZN', exchange: 'XNAS', type: 'STOCK', valuePct: 30 },
      ],
      cashPct: 20,
    };
    const composition = deriveCopyComposition(copy, SECURITIES);
    const positions = explodeCopyHoldings(copy, SECURITIES);
    for (const { sector, weight } of composition.sectors) {
      const fromPositions = positions
        .filter((p) => p.security && (p.security as { sector?: string }).sector === sector)
        .reduce((s, p) => s + p.weight, 0);
      expect(fromPositions).toBeCloseTo(weight);
    }
  });
});
