// Investment categories priced from market data (stocks, ETFs/funds, crypto).
// A buy or sell in one of them needs quantity and price: without a quantity the
// portfolio engine counts a buy as 1 unit worth the whole amount. Stocks and
// crypto also need a ticker, or the holding can't be priced at all. Funds
// (API_FUND) may be ticker-less — private / unlisted funds have none; the
// holding is keyed "<category>:<description>" and priced from manual values.
// MANUAL investments (e.g. real estate) are tracked by amount and stay optional.
// The hint lists and the ticker rule come from @bliss/shared/portfolio
// (enrichment.js), shared with the Plaid / Smart Import review gates; the web
// app mirrors them in apps/web/src/lib/investment-utils.ts.
import {
  MANDATORY_ENRICHMENT_HINTS,
  requiresInvestmentEnrichment,
  requiresTicker,
} from '@bliss/shared/portfolio';

export { MANDATORY_ENRICHMENT_HINTS, requiresInvestmentEnrichment };

const isPositive = (value) => {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
};

/**
 * Names of the enrichment fields a transaction in `category` is missing, or an
 * empty array when the category doesn't require them. A ticker (not required for
 * funds) must contain a letter (the same rule the portfolio key uses); quantity
 * and price must be > 0.
 * A sell's quantity may be sent signed, so its magnitude is checked.
 */
export function missingInvestmentFields(category, { ticker, assetQuantity, assetPrice } = {}) {
  if (!requiresInvestmentEnrichment(category)) return [];
  const missing = [];
  if (requiresTicker(category.processingHint) && (typeof ticker !== 'string' || !/[a-zA-Z]/.test(ticker))) {
    missing.push('ticker');
  }
  const quantity = assetQuantity === null || assetQuantity === undefined || assetQuantity === ''
    ? assetQuantity
    : Math.abs(Number(assetQuantity));
  if (!isPositive(quantity)) missing.push('assetQuantity');
  if (!isPositive(assetPrice)) missing.push('assetPrice');
  return missing;
}

export function missingInvestmentFieldsError(category, missing) {
  return {
    error: requiresTicker(category.processingHint)
      ? `${category.name} transactions require ticker, assetQuantity and assetPrice (quantity and price greater than 0).`
      : `${category.name} transactions require assetQuantity and assetPrice (greater than 0); ticker is optional.`,
    missingFields: missing,
  };
}
