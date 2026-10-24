/**
 * Unit tests for the eToro instrument mapper and scope check in
 * `@bliss/shared/etoro` (#143). `packages/shared` has no test runner, so they
 * are tested here against the ESM build.
 *
 * Instruments come from the spike's live runs (exchange IDs and `symbolFull`
 * values as eToro returned them).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ETORO_EXCHANGES,
  mapEtoroInstrument,
  assertReadOnlyScopes,
  isReadScope,
  EtoroScopeError,
} from '@bliss/shared/etoro';

const map = (symbolFull: string, exchangeID: number, instrumentTypeID?: number) =>
  mapEtoroInstrument({ symbolFull, exchangeID, instrumentTypeID });

describe('mapEtoroInstrument', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    // [symbolFull, exchangeID, symbol, MIC]
    ['AIR.PA', 9, 'AIR', 'XPAR'],
    ['BRK.B', 5, 'BRK.B', 'XNYS'],
    ['NOVO-B.CO', 16, 'NOVO-B', 'XCSE'],
    ['1810.HK', 21, '1810', 'XHKG'],
    ['ASML', 4, 'ASML', 'XNAS'],
    ['ASML.NV', 30, 'ASML', 'XAMS'],
    ['SAP.DE', 6, 'SAP', 'XFRA'],
    ['VWCE.DE', 38, 'VWCE', 'XETR'],
    ['SAN.MC', 10, 'SAN', 'XMAD'],
    ['ENI.MI', 11, 'ENI', 'XMIL'],
    ['7203.T', 56, '7203', 'XJPX'],
    ['SHOP.TO', 18, 'SHOP', 'XTSE'],
    ['ABI.BR', 23, 'ABI', 'XBRU'],
    ['BHP.ASX', 31, 'BHP', 'XASX'],
    ['BOO.L', 42, 'BOO', 'XLON'],
    ['TEVA.TA', 58, 'TEVA', 'XTAE'],
    ['ULVR.L', 7, 'ULVR', 'XLON'],
    ['NESN.ZU', 12, 'NESN', 'XSWX'],
    ['EQNR.OL', 14, 'EQNR', 'XOSL'],
    ['VOLV-B.ST', 15, 'VOLV-B', 'XSTO'],
    ['NOKIA.HE', 17, 'NOKIA', 'XHEL'],
    ['INDA', 20, 'INDA', 'BATS'],
    ['JMT.LSB', 22, 'JMT', 'XLIS'],
    ['EMAAR.AE', 39, 'EMAAR', 'XDFM'],
  ])('maps %s (exchange %i) to %s/%s', (symbolFull, exchangeID, symbol, mic) => {
    expect(map(symbolFull, exchangeID)).toEqual({ symbol, exchange: mic, type: null, usVariant: false, nonEquity: null });
  });

  it('keeps ASML on Nasdaq and ASML.NV on Amsterdam as two listings', () => {
    const us = map('ASML', 4);
    const nl = map('ASML.NV', 30);
    expect([us, nl].map((m) => 'exchange' in m && m.exchange)).toEqual(['XNAS', 'XAMS']);
  });

  it('maps the Regular Trading Hours variant to the plain US symbol with no venue', () => {
    expect(map('AMZN.RTH', 33)).toEqual({ symbol: 'AMZN', exchange: null, type: null, usVariant: true, nonEquity: null });
  });

  it('maps crypto, commodities, currencies, index CFDs and futures as non-equity', () => {
    expect(map('BTC', 8, 10)).toEqual({ symbol: 'BTC', exchange: null, type: 'CRYPTO', usVariant: false, nonEquity: 'CRYPTO' });
    expect(map('GOLD', 2, 2)).toMatchObject({ nonEquity: 'COMMODITY', exchange: null });
    expect(map('EURUSD', 1, 1)).toMatchObject({ nonEquity: 'CURRENCY' });
    expect(map('SPX500', 3, 4)).toMatchObject({ nonEquity: 'INDEX' });
    expect(map('ES', 40)).toMatchObject({ nonEquity: 'FUTURE' });
    // The instrument type wins over an unknown or venue exchange id.
    expect(map('ETH', 99, 10)).toMatchObject({ nonEquity: 'CRYPTO' });
  });

  it('strips a suffix only when it belongs to the instrument\'s own exchange', () => {
    // A ".L" on a Nasdaq listing is part of the symbol, not a venue suffix.
    expect(map('ABC.L', 4)).toMatchObject({ symbol: 'ABC.L', exchange: 'XNAS' });
    // An LSE listing without the suffix stays as is.
    expect(map('NVTK', 7)).toMatchObject({ symbol: 'NVTK', exchange: 'XLON' });
    // A bare suffix is never stripped to an empty symbol.
    expect(map('.PA', 9)).toMatchObject({ symbol: '.PA' });
  });

  it('normalizes case and whitespace and accepts string ids', () => {
    expect(mapEtoroInstrument({ symbolFull: ' air.pa ', exchangeID: '9' })).toMatchObject({ symbol: 'AIR', exchange: 'XPAR' });
  });

  it('reports the eToro instrument type (5 stock, 6 ETF)', () => {
    expect(map('AAPL', 4, 5)).toMatchObject({ type: 'STOCK' });
    expect(map('SPY', 5, 6)).toMatchObject({ type: 'ETF' });
    expect(map('XYZ', 4, 99)).toMatchObject({ type: null });
  });

  it('returns "unresolved" for an unknown exchange and logs it', () => {
    const logger = { warn: vi.fn() };
    const result = mapEtoroInstrument({ symbolFull: 'XYZ', exchangeID: 99, instrumentID: 1234 }, { logger });
    expect(result).toEqual({ unresolved: true, reason: 'UNKNOWN_EXCHANGE', exchangeId: 99 });
    expect(logger.warn).toHaveBeenCalledWith('etoro_unmapped_instrument', {
      reason: 'UNKNOWN_EXCHANGE',
      exchangeId: 99,
      instrumentId: 1234,
    });
  });

  it('returns "unresolved" for a missing symbol or exchange', () => {
    expect(mapEtoroInstrument({ exchangeID: 4 })).toMatchObject({ unresolved: true, reason: 'MISSING_SYMBOL' });
    expect(mapEtoroInstrument({ symbolFull: 'AAPL' })).toMatchObject({ unresolved: true, reason: 'UNKNOWN_EXCHANGE' });
    expect(mapEtoroInstrument()).toMatchObject({ unresolved: true });
  });

  it('makes no network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call');
    });
    for (const id of Object.keys(ETORO_EXCHANGES)) map('TEST', Number(id));
    map('TEST', 99);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('covers every exchange eToro lists (1–24, 30–58)', () => {
    const ids = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 29 }, (_, i) => i + 30)];
    expect(Object.keys(ETORO_EXCHANGES).map(Number).sort((a, b) => a - b)).toEqual(ids);
  });

  it('marks the venues seen live in the spike as verified', () => {
    const verifiedIds = Object.entries(ETORO_EXCHANGES)
      .filter(([, e]) => (e as { verified: boolean }).verified)
      .map(([id]) => Number(id));
    expect(verifiedIds).toEqual([4, 5, 6, 7, 9, 12, 14, 15, 16, 17, 20, 21, 22, 30, 33, 39]);
  });
});

describe('assertReadOnlyScopes', () => {
  it('accepts a read-only key', () => {
    const scopes = ['trade.real:read', ' trade.demo:read', 'crypto:READ'];
    expect(assertReadOnlyScopes(scopes)).toEqual(['trade.real:read', 'trade.demo:read', 'crypto:READ']);
  });

  it('refuses any write scope and names it', () => {
    try {
      assertReadOnlyScopes(['trade.real:read', 'trade.real:write']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EtoroScopeError);
      expect((err as EtoroScopeError).code).toBe('ETORO_WRITE_SCOPE');
      expect((err as EtoroScopeError).writeScopes).toEqual(['trade.real:write']);
    }
  });

  it('refuses a key that reports no scopes', () => {
    expect(() => assertReadOnlyScopes([])).toThrow(EtoroScopeError);
    expect(() => assertReadOnlyScopes(undefined as unknown as string[])).toThrow(EtoroScopeError);
  });

  it('isReadScope only matches a trailing ":read"', () => {
    expect(isReadScope('trade.real:read')).toBe(true);
    expect(isReadScope('read:trade')).toBe(false);
    expect(isReadScope('trade.real:readwrite')).toBe(false);
    expect(isReadScope(null)).toBe(false);
  });
});
