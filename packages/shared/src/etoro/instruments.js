/**
 * eToro instrument → Twelve Data listing mapper (#143).
 *
 * Pure: a fixed exchange table plus suffix rules. No database, no network, no
 * alias cache. eToro's instrument metadata carries `symbolFull` (e.g.
 * "AIR.PA", "NOVO-B.CO", "AMZN.RTH") and `exchangeID`; it has no ISIN,
 * country or sector. `priceSource` is the data vendor, not the venue, so the
 * venue always comes from `exchangeID` (spike #143, run 6).
 *
 * See docs/specs/backend/25-etoro-copy-trading.md.
 */

/** eToro `exchangeID` → venue MIC and the suffix eToro appends for it. */
export const ETORO_EXCHANGES = Object.freeze({
  4: Object.freeze({ mic: 'XNAS', suffix: null, name: 'Nasdaq' }),
  5: Object.freeze({ mic: 'XNYS', suffix: null, name: 'NYSE' }),
  // eToro labels it "FRA", its metadata says Xetra; Twelve Data lists the
  // `.DE` primaries on XETR (implementation plan D9).
  6: Object.freeze({ mic: 'XETR', suffix: '.DE', name: 'Xetra' }),
  7: Object.freeze({ mic: 'XLON', suffix: '.L', name: 'London Stock Exchange' }),
  9: Object.freeze({ mic: 'XPAR', suffix: '.PA', name: 'Euronext Paris' }),
  12: Object.freeze({ mic: 'XSWX', suffix: '.ZU', name: 'SIX Swiss Exchange' }),
  14: Object.freeze({ mic: 'XOSL', suffix: '.OL', name: 'Oslo Børs' }),
  15: Object.freeze({ mic: 'XSTO', suffix: '.ST', name: 'Nasdaq Stockholm' }),
  16: Object.freeze({ mic: 'XCSE', suffix: '.CO', name: 'Nasdaq Copenhagen' }),
  17: Object.freeze({ mic: 'XHEL', suffix: '.HE', name: 'Nasdaq Helsinki' }),
  20: Object.freeze({ mic: 'BATS', suffix: null, name: 'Cboe BZX' }),
  21: Object.freeze({ mic: 'XHKG', suffix: '.HK', name: 'Hong Kong Exchanges' }),
  22: Object.freeze({ mic: 'XLIS', suffix: '.LSB', name: 'Euronext Lisbon' }),
  30: Object.freeze({ mic: 'XAMS', suffix: '.NV', name: 'Euronext Amsterdam' }),
  // "Regular Trading Hours" is an eToro variant of a US listing, not a venue:
  // `AMZN.RTH` is Amazon. The mapper returns the plain symbol with no MIC and
  // `rthVariant: true`; `mergeCopyHoldings` folds it into the US sibling.
  33: Object.freeze({ mic: null, suffix: '.RTH', name: 'Regular Trading Hours', rth: true }),
  39: Object.freeze({ mic: 'XDFM', suffix: '.AE', name: 'Dubai Financial Market' }),
});

/** MICs a Regular Trading Hours variant can merge into. */
export const US_MICS = Object.freeze(['XNAS', 'XNYS', 'BATS']);

/** eToro `instrumentTypeID` values the mapper understands. */
export const ETORO_INSTRUMENT_TYPES = Object.freeze({ 5: 'STOCK', 6: 'ETF' });

/**
 * Map one eToro instrument to a Twelve Data symbol + MIC.
 *
 * A suffix is stripped only when it is the suffix of that instrument's own
 * exchange, so share classes (`BRK.B`, `NOVO-B`) and dotted symbols on venues
 * without a suffix stay intact.
 *
 * @param {Object} instrument
 * @param {string} instrument.symbolFull       eToro symbol, e.g. "AIR.PA"
 * @param {number|string} instrument.exchangeID
 * @param {number|string} [instrument.instrumentTypeID]  5 stock, 6 ETF
 * @param {Object} [opts]
 * @param {{ warn: Function }} [opts.logger]   receives `etoro_unmapped_instrument` for unresolved instruments
 * @returns {{ symbol: string, exchange: string|null, type: 'STOCK'|'ETF'|null, rthVariant: boolean }
 *          | { unresolved: true, reason: 'MISSING_SYMBOL'|'UNKNOWN_EXCHANGE', exchangeId: number|null }}
 */
export function mapEtoroInstrument(instrument = {}, { logger } = {}) {
  const raw = typeof instrument?.symbolFull === 'string' ? instrument.symbolFull.trim().toUpperCase() : '';
  const exchangeId = toInt(instrument?.exchangeID);
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
  if (!exchange) return unresolved('UNKNOWN_EXCHANGE');

  let symbol = raw;
  if (exchange.suffix && symbol.endsWith(exchange.suffix) && symbol.length > exchange.suffix.length) {
    symbol = symbol.slice(0, -exchange.suffix.length);
  }

  return {
    symbol,
    exchange: exchange.mic,
    type: ETORO_INSTRUMENT_TYPES[toInt(instrument?.instrumentTypeID)] || null,
    rthVariant: exchange.rth === true,
  };
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isInteger(n) ? n : null;
}
