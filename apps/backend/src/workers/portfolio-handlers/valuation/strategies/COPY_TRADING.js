/**
 * Pricing strategy for COPY_TRADING (eToro copy trades, #143).
 *
 * A linked copy is valued at eToro's copy value, a TOTAL (never multiplied by
 * quantity), from the first eToro day on; later days without a value carry
 * the last one forward ('ETORO:FORWARD'), so a stopped copy or a broken
 * connection keeps its last value (R12).
 *
 *  1. A manual value on the exact day wins (R11). It is per unit, like MANUAL.
 *  2. On or after the first eToro day: eToro's value (total, eToro currency).
 *  3. Before it (before the connection, or never linked): exactly the MANUAL
 *     behaviour — manual values, forward-filled; the caller falls back to cost
 *     basis when there are none. History before the connection never changes.
 *
 * `priceCaches.copyValueMap`: Map<YYYY-MM-DD, { value: Decimal, currency }>,
 * built by price-fetcher.js from EtoroCopyValue.
 */

const MANUAL = require('./MANUAL');

const getPrice = async (portfolioItem, targetDate, priceCaches) => {
    const targetDateStr = targetDate.toISOString().split('T')[0];
    const { manualValueMap, copyValueMap } = priceCaches;

    if (manualValueMap.has(targetDateStr)) {
        return { price: manualValueMap.get(targetDateStr).value, source: 'Manual' };
    }

    const days = priceCaches.copyValueDays
        || (priceCaches.copyValueDays = Array.from(copyValueMap?.keys() || []).sort());
    if (days.length > 0 && targetDateStr >= days[0]) {
        if (copyValueMap.has(targetDateStr)) {
            const v = copyValueMap.get(targetDateStr);
            return { totalValue: v.value, totalValueCurrency: v.currency, source: 'ETORO' };
        }
        for (let i = days.length - 1; i >= 0; i--) {
            if (days[i] <= targetDateStr) {
                const v = copyValueMap.get(days[i]);
                return { totalValue: v.value, totalValueCurrency: v.currency, source: 'ETORO:FORWARD' };
            }
        }
    }

    return MANUAL.getPrice(portfolioItem, targetDate, priceCaches);
};

module.exports = { getPrice };
