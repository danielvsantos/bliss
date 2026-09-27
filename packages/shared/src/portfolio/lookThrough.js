/**
 * ETF look-through for the equity sector and country views (Equity Analysis #79).
 *
 * Shared by the API (Equity Analysis) and the backend (sector concentration in
 * AI insights, #80). Pure: no I/O.
 */

import { normalizeEtfComposition } from './assetClass.js';

/** Bucket for an ETF that can't be looked through (no composition, industry view, toggle off). */
export const DIVERSIFIED = 'Diversified';

/** Bucket for the part of an ETF's weights that doesn't add up to 100% (cash, other). */
export const LOOK_THROUGH_OTHER = 'Other';

/** Bucket for bond ETFs in the equity sector/country views when looking through. */
export const FIXED_INCOME_BUCKET = 'Fixed Income';

/** Dimensions `lookThrough` can split an ETF across. */
export const LOOK_THROUGH_DIMENSIONS = ['sector', 'country'];

const LOOKED_THROUGH_CLASSES = ['INDEX_ETF', 'SECTOR_ETF'];
const DIRECT_CLASSES = ['STOCK', 'REIT', 'FUND', 'OTHER'];

const COMPOSITION_LIST = { sector: 'sectors', country: 'countries' };

/**
 * Split each holding's value across the groups of `dimension`.
 *
 * - STOCK / REIT (and FUND / OTHER): their own `sector` / `country`, or "Unknown".
 * - INDEX_ETF / SECTOR_ETF with composition: `value × weight` to each sector or
 *   country; `1 − Σweights` to "Other". An empty list → "Diversified".
 * - ETFs without composition → "Diversified".
 * - BOND_ETF → "Fixed Income", so bond funds never inflate an equity sector.
 * - Bonds, real estate, crypto and cash are not equity holdings and are skipped.
 * - `enabled: false` (the page toggle) gives the pre-look-through behaviour:
 *   every ETF (`isEtf`) is one "Diversified" bucket.
 * - `dimension` other than sector / country (e.g. industry) is never looked
 *   through: ETFs are "Diversified".
 *
 * @param {Array<{value: number, assetClass: string, isEtf?: boolean, sector?: string|null,
 *                country?: string|null, industry?: string|null, composition?: Object|null}>} holdings
 * @param {'sector'|'country'|'industry'} dimension
 * @param {Object} [opts]
 * @param {boolean} [opts.enabled=true]
 * @returns {Array<{ name: string, value: number, holdings: Array<{ index: number, value: number }> }>}
 *   groups, largest first; `holdings[].index` points into the input array
 */
export function lookThrough(holdings = [], dimension = 'sector', { enabled = true } = {}) {
  const groups = new Map();
  const add = (name, index, value) => {
    if (!(value > 0)) return;
    const g = groups.get(name) || { name, value: 0, holdings: [] };
    g.value += value;
    const existing = g.holdings.find((h) => h.index === index);
    if (existing) existing.value += value;
    else g.holdings.push({ index, value });
    groups.set(name, g);
  };
  const own = (h) => (typeof h[dimension] === 'string' && h[dimension].trim()) || 'Unknown';
  const splittable = enabled && LOOK_THROUGH_DIMENSIONS.includes(dimension);

  holdings.forEach((h, index) => {
    const value = typeof h?.value === 'number' ? h.value : parseFloat(h?.value);
    if (!(value > 0)) return;
    const cls = h.assetClass;
    const etf = h.isEtf === true || LOOKED_THROUGH_CLASSES.includes(cls) || cls === 'BOND_ETF';

    if (!enabled) {
      if (!etf && !DIRECT_CLASSES.includes(cls)) return;
      add(etf ? DIVERSIFIED : own(h), index, value);
      return;
    }

    if (cls === 'BOND_ETF') {
      add(splittable ? FIXED_INCOME_BUCKET : DIVERSIFIED, index, value);
      return;
    }
    if (LOOKED_THROUGH_CLASSES.includes(cls)) {
      const composition = splittable ? normalizeEtfComposition(h.composition) : null;
      const list = composition?.[COMPOSITION_LIST[dimension]] || [];
      if (list.length === 0) {
        add(DIVERSIFIED, index, value);
        return;
      }
      let assigned = 0;
      for (const entry of list) {
        add(entry[dimension], index, value * entry.weight);
        assigned += entry.weight;
      }
      if (1 - assigned > 1e-6) add(LOOK_THROUGH_OTHER, index, value * (1 - assigned));
      return;
    }
    if (DIRECT_CLASSES.includes(cls)) add(own(h), index, value);
    // GOV_BOND, CORP_BOND, REAL_ESTATE, CRYPTO, CASH: not equity holdings.
  });

  return [...groups.values()].sort((a, b) => b.value - a.value);
}
