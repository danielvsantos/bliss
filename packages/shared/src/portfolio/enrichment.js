/**
 * Investment enrichment rule — which of ticker / quantity / price a review row
 * (Smart Import, Plaid) must carry before it can be committed or promoted.
 *
 * Shared by the API and the backend workers. The web review UI doesn't depend
 * on @bliss/shared and mirrors it in apps/web/src/lib/investment-utils.ts —
 * keep the two in sync.
 *
 *  - API_STOCK / API_CRYPTO: ticker + quantity + price. They are priced from
 *    market data, so a holding without a ticker can never be valued.
 *  - API_FUND: quantity + price; the ticker is optional. Private / unlisted
 *    funds have no ticker, and the portfolio engine already supports them: the
 *    TICKER key strategy falls back to "<category>:<description>", the item is
 *    created with source MANUAL and is priced from manual values.
 *  - Any other hint (MANUAL, CASH, …): not mandatory.
 */

export const MANDATORY_ENRICHMENT_HINTS = Object.freeze(['API_STOCK', 'API_CRYPTO', 'API_FUND']);

/** Mandatory-enrichment hints that can be enriched without a ticker. */
export const TICKER_OPTIONAL_HINTS = Object.freeze(['API_FUND']);

/** A real ticker has at least one letter (pure numerics like "0" are placeholders). */
export function isValidTicker(ticker) {
  return typeof ticker === 'string' && /[a-zA-Z]/.test(ticker);
}

/** True when an Investments category with this hint must be enriched before commit. */
export function requiresInvestmentEnrichment(category) {
  return !!category && category.type === 'Investments'
    && MANDATORY_ENRICHMENT_HINTS.includes(category.processingHint);
}

/** True when the hint needs a ticker on top of quantity + price. */
export function requiresTicker(processingHint) {
  return MANDATORY_ENRICHMENT_HINTS.includes(processingHint) && !TICKER_OPTIONAL_HINTS.includes(processingHint);
}

/**
 * True when `row` carries everything its category needs. Categories that do
 * not require enrichment are always complete. Quantity and price are "present"
 * when not null/undefined/'' (0 is a value).
 */
export function isInvestmentEnrichmentComplete(category, row) {
  if (!requiresInvestmentEnrichment(category)) return true;
  const present = (v) => v !== null && v !== undefined && v !== '';
  if (!present(row?.assetQuantity) || !present(row?.assetPrice)) return false;
  return !requiresTicker(category.processingHint) || isValidTicker(row?.ticker);
}
