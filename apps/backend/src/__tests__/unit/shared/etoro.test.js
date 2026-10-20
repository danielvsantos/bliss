/**
 * @bliss/shared/etoro and the copy-trade look-through from the backend (CJS) — #143.
 *
 * The eToro sync (plaid-sync queue) and the #80 insight lenses `require` these,
 * so this checks the CJS build loads and maps / derives exactly like the ESM
 * build the API tests cover in depth.
 */
const { mapEtoroInstrument, assertReadOnlyScopes } = require('@bliss/shared/etoro');
const { deriveCopyComposition, classifyAssetClass, lookThrough } = require('@bliss/shared/portfolio');

describe('@bliss/shared/etoro (CJS build)', () => {
  it('maps eToro instruments to Twelve Data listings', () => {
    expect(mapEtoroInstrument({ symbolFull: 'AIR.PA', exchangeID: 9 })).toEqual({
      symbol: 'AIR', exchange: 'XPAR', type: null, rthVariant: false,
    });
    expect(mapEtoroInstrument({ symbolFull: 'AMZN.RTH', exchangeID: 33 })).toMatchObject({ symbol: 'AMZN', rthVariant: true });
    expect(mapEtoroInstrument({ symbolFull: 'X', exchangeID: 99 })).toMatchObject({ unresolved: true });
  });

  it('refuses write scopes', () => {
    expect(() => assertReadOnlyScopes(['trade.real:write'])).toThrow(/Read key/);
  });
});

describe('copy-trade look-through (CJS build)', () => {
  it('classifies a Copy Trading holding and splits it by its holdings', () => {
    expect(classifyAssetClass({ processingHint: 'COPY_TRADING' }).assetClass).toBe('COPY_TRADE');
    const composition = deriveCopyComposition(
      { holdings: [{ symbol: 'MSFT', exchange: 'XNAS', valuePct: 60 }], cashPct: 40 },
      { MSFT: { assetType: 'Common Stock', sector: 'Technology', country: 'United States' } },
    );
    const groups = lookThrough([{ value: 1000, assetClass: 'COPY_TRADE', composition }], 'sector');
    expect(groups.map((g) => [g.name, Math.round(g.value)])).toEqual([['Technology', 600], ['Other', 400]]);
  });
});
