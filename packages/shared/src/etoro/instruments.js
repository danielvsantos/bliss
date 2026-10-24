/**
 * eToro instrument → Twelve Data listing mapper (#143).
 *
 * Pure: a fixed exchange table plus suffix rules. No database, no network, no
 * alias cache. eToro's instrument metadata carries `symbolFull` (e.g.
 * "AIR.PA", "NOVO-B.CO", "AMZN.RTH"), `exchangeID` and `instrumentTypeID`; it
 * has no ISIN, country or sector. `priceSource` is the data vendor, not the
 * venue, so the venue always comes from `exchangeID`.
 *
 * The exchange ids and descriptions are eToro's own list (its exchanges
 * endpoint). `verified: true` marks venues whose suffix was seen on live
 * instruments in the #143 spike; the other suffixes follow eToro's usual
 * convention and are only ever stripped on an exact match, so a wrong guess
 * leaves the symbol intact (and unenriched) instead of corrupting it.
 *
 * See docs/specs/backend/25-etoro-copy-trading.md.
 */

const venue = (mic, suffixes, name, extra = {}) =>
  Object.freeze({ mic, suffixes: Object.freeze(suffixes), name, verified: false, ...extra });
const verified = (mic, suffixes, name, extra = {}) => venue(mic, suffixes, name, { ...extra, verified: true });

/**
 * eToro `exchangeID` → venue.
 *   - `mic`: Twelve Data MIC, or null when the "exchange" isn't a venue.
 *   - `suffixes`: the suffixes eToro appends to symbols of that venue.
 *   - `usVariant`: an eToro variant of a US listing (Regular Trading Hours):
 *     mapped to the plain symbol with no MIC and folded into the copy's US line.
 *   - `nonEquity`: not a stock/ETF listing (currencies, commodities, index
 *     CFDs, futures, crypto). Never enriched; counted in the asset-class mix.
 */
export const ETORO_EXCHANGES = Object.freeze({
  1: venue(null, [], 'FX', { nonEquity: 'CURRENCY' }),
  2: venue(null, [], 'Commodity', { nonEquity: 'COMMODITY' }),
  3: venue(null, [], 'CFD', { nonEquity: 'INDEX' }),
  4: verified('XNAS', [], 'Nasdaq'),
  5: verified('XNYS', [], 'NYSE'),
  // eToro lists 6 as "FRA" (Frankfurt) and Xetra ETFs separately as 38.
  6: verified('XFRA', ['.DE'], 'FRA'),
  7: verified('XLON', ['.L'], 'LSE'),
  8: venue(null, [], 'Digital Currency', { nonEquity: 'CRYPTO' }),
  9: verified('XPAR', ['.PA'], 'Euronext Paris'),
  10: venue('XMAD', ['.MC'], 'Bolsa De Madrid'),
  11: venue('XMIL', ['.MI'], 'Borsa Italiana'),
  12: verified('XSWX', ['.ZU'], 'SIX'),
  13: venue('XJPX', ['.T'], 'TYO'),
  14: verified('XOSL', ['.OL'], 'Oslo Stock Exchange'),
  15: verified('XSTO', ['.ST'], 'Stockholm Stock Exchange'),
  16: verified('XCSE', ['.CO'], 'Copenhagen Stock Exchange'),
  17: verified('XHEL', ['.HE'], 'Helsinki Stock Exchange'),
  18: venue('XTSE', ['.TO'], 'Toronto Stock Exchange'),
  19: venue('OTCM', [], 'OTC Markets Stock Exchange'),
  20: verified('BATS', [], 'Chicago Board Options Exchange'),
  21: verified('XHKG', ['.HK'], 'Hong Kong Exchanges'),
  22: verified('XLIS', ['.LSB'], 'Euronext Lisbon'),
  23: venue('XBRU', ['.BR'], 'Euronext Brussels'),
  24: venue('XSAU', ['.SR'], 'Tadawul'),
  30: verified('XAMS', ['.NV'], 'Euronext Amsterdam'),
  31: venue('XASX', ['.ASX', '.AX'], 'Sydney'),
  32: venue('XWBO', ['.VI'], 'Vienna'),
  33: verified(null, ['.RTH'], 'Regular Trading Hours - RTH', { usVariant: true }),
  34: venue('XMSM', ['.ISE', '.IR'], 'Dublin EN'),
  35: venue('XPRA', ['.PR'], 'Prague SE'),
  36: venue('XWAR', ['.WA'], 'Warsaw'),
  37: venue('XBUD', ['.BD'], 'Budapest'),
  38: venue('XETR', ['.DE'], 'Xetra ETFs'),
  39: verified('XDFM', ['.AE'], 'Dubai Financial Market'),
  40: venue(null, [], 'CME', { nonEquity: 'FUTURE' }),
  41: venue('XADS', ['.AD'], 'Abu Dhabi'),
  42: venue('XLON', ['.L'], 'LSE_AIM'),
  43: venue('XLON', ['.L'], 'LSE AIM Auction'),
  44: venue('XLON', ['.L'], 'LSE Auction'),
  45: venue('XSHE', ['.SZ'], 'Shenzen Stock Exchange'),
  46: venue('XSHG', ['.SS', '.SH'], 'Shanghai Stock Exchange'),
  47: venue('XNSE', ['.NS'], 'National Stock Exchange of India'),
  48: venue('XTSX', ['.V'], 'TSX Venture Exchange'),
  49: venue('XSES', ['.SI'], 'Singapore Exchange'),
  50: venue('XICE', ['.IC'], 'Nasdaq Iceland'),
  51: venue('XTAL', ['.TL'], 'Nasdaq Tallinn'),
  52: venue('XLIT', ['.VS'], 'Nasdaq Vilnius'),
  53: venue('XRIS', ['.RG'], 'Nasdaq Riga'),
  54: venue('XKRX', ['.KS'], 'Korea Exchange'),
  55: venue('XTAI', ['.TW'], 'Taiwan Stock Exchange'),
  56: venue('XJPX', ['.T'], 'Tokyo Stock Exchange'),
  // A new venue for US companies dual-listed in Texas: treated like the RTH variant.
  57: venue(null, ['.TXSE'], 'Texas Stock Exchange', { usVariant: true }),
  58: venue('XTAE', ['.TA'], 'TASE- Tel Aviv Stocks Exchange'),
});

/** MICs a US variant (RTH, Texas) folds into. */
export const US_MICS = Object.freeze(['XNAS', 'XNYS', 'BATS']);

/** eToro `instrumentTypeID` values. */
export const ETORO_INSTRUMENT_TYPES = Object.freeze({
  1: 'CURRENCY',
  2: 'COMMODITY',
  4: 'INDEX',
  5: 'STOCK',
  6: 'ETF',
  10: 'CRYPTO',
});

const NON_EQUITY_TYPES = new Set(['CURRENCY', 'COMMODITY', 'INDEX', 'CRYPTO']);

/**
 * Map one eToro instrument to a Twelve Data symbol + MIC.
 *
 * A suffix is stripped only when it is one of the suffixes of that
 * instrument's own exchange, so share classes (`BRK.B`, `NOVO-B`) and dotted
 * symbols on venues without a suffix stay intact.
 *
 * Non-equity instruments (by exchange or by `instrumentTypeID`: currencies,
 * commodities, index CFDs, futures, crypto) are mapped with `nonEquity` set
 * and no MIC: they are part of the copy's asset-class mix, never enriched.
 *
 * @param {Object} instrument
 * @param {string} instrument.symbolFull       eToro symbol, e.g. "AIR.PA"
 * @param {number|string} instrument.exchangeID
 * @param {number|string} [instrument.instrumentTypeID]  5 stock, 6 ETF, 10 crypto, …
 * @param {Object} [opts]
 * @param {{ warn: Function }} [opts.logger]   receives `etoro_unmapped_instrument` for unresolved instruments
 * @returns {{ symbol: string, exchange: string|null, type: string|null, usVariant: boolean, nonEquity: string|null }
 *          | { unresolved: true, reason: 'MISSING_SYMBOL'|'UNKNOWN_EXCHANGE', exchangeId: number|null }}
 */
export function mapEtoroInstrument(instrument = {}, { logger } = {}) {
  const raw = typeof instrument?.symbolFull === 'string' ? instrument.symbolFull.trim().toUpperCase() : '';
  const exchangeId = toInt(instrument?.exchangeID);
  const type = ETORO_INSTRUMENT_TYPES[toInt(instrument?.instrumentTypeID)] || null;
  const unresolved = (reason) => {
    logger?.warn?.('etoro_unmapped_instrument', {
      reason,
      exchangeId,
      instrumentId: instrument?.instrumentID ?? instrument?.instrumentId ?? null,
    });
    return { unresolved: true, reason, exchangeId };
  };

  if (!raw) return unresolved('MISSING_SYMBOL');
  const exchange = exchangeId == null ? null : ETORO_EXCHANGES[exchangeId];

  const nonEquity = (type && NON_EQUITY_TYPES.has(type) ? type : null) || exchange?.nonEquity || null;
  if (nonEquity) {
    return { symbol: raw, exchange: null, type, usVariant: false, nonEquity };
  }
  if (!exchange) return unresolved('UNKNOWN_EXCHANGE');

  let symbol = raw;
  const suffix = exchange.suffixes.find((s) => symbol.endsWith(s) && symbol.length > s.length);
  if (suffix) symbol = symbol.slice(0, -suffix.length);

  return {
    symbol,
    exchange: exchange.mic,
    type,
    usVariant: exchange.usVariant === true,
    nonEquity: null,
  };
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isInteger(n) ? n : null;
}
