/**
 * Turn one parsed eToro copy into the holdings Bliss stores on `EtoroCopy`
 * (#143): each instrument mapped to a Twelve Data listing, with its share of
 * the copy's value. Pure: instrument metadata is passed in.
 *
 * See docs/specs/backend/25-etoro-copy-trading.md.
 */

import { mapEtoroInstrument } from './instruments.js';

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * @param {{ value: number, cash: number, instruments: Array<{ instrumentId: number, value: number }> }} copy
 *   one entry of `parseCopies().copies`
 * @param {Map<number, Object>} instrumentMeta  eToro instrument metadata by id (`getInstruments()`)
 * @param {Object} [opts]
 * @param {{ warn: Function }} [opts.logger]
 * @returns {{ holdings: Array<{ instrumentId: number, etoroSymbol: string|null, symbol?: string,
 *             exchange?: string|null, type?: string|null, usVariant?: boolean, nonEquity?: string|null,
 *             unresolved?: boolean, valuePct: number }>, cashPct: number, unmappedPct: number }}
 *   `valuePct`, `cashPct` and `unmappedPct` are 0–100 of the copy's value. Instruments with no
 *   positive value (closed out, or a short's negative equity) are left out.
 */
export function buildCopyHoldings(copy, instrumentMeta = new Map(), { logger } = {}) {
  const total = Number(copy?.value) > 0 ? Number(copy.value) : 0;
  if (!total) return { holdings: [], cashPct: 0, unmappedPct: 0 };

  const holdings = [];
  let unmappedPct = 0;
  for (const inst of copy.instruments || []) {
    if (!(inst.value > 0)) continue;
    const valuePct = round6((inst.value / total) * 100);
    const meta = instrumentMeta.get(inst.instrumentId);
    const mapped = meta
      ? mapEtoroInstrument({ ...meta, instrumentId: inst.instrumentId }, { logger })
      : mapEtoroInstrument({ instrumentId: inst.instrumentId }, { logger });
    if (mapped.unresolved) unmappedPct += valuePct;
    holdings.push({
      instrumentId: inst.instrumentId,
      etoroSymbol: typeof meta?.symbolFull === 'string' ? meta.symbolFull : null,
      ...mapped,
      valuePct,
    });
  }
  holdings.sort((a, b) => b.valuePct - a.valuePct);
  return {
    holdings,
    cashPct: round6((Math.max(Number(copy.cash) || 0, 0) / total) * 100),
    unmappedPct: round6(unmappedPct),
  };
}
