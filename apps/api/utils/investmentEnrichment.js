// Investment categories priced from market data (stocks, ETFs/funds, crypto).
// A buy or sell in one of them needs ticker, quantity and price: without a
// quantity the portfolio engine counts a buy as 1 unit worth the whole amount,
// and without a ticker the holding can't be priced at all. MANUAL investments
// (e.g. real estate) are tracked by amount and stay optional.
// Same set as the Plaid / Smart Import review gates and the web app's
// `isMandatoryEnrichmentCategory` (apps/web/src/lib/investment-utils.ts).
export const MANDATORY_ENRICHMENT_HINTS = ['API_STOCK', 'API_CRYPTO', 'API_FUND'];

export function requiresInvestmentEnrichment(category) {
  return !!category
    && category.type === 'Investments'
    && MANDATORY_ENRICHMENT_HINTS.includes(category.processingHint);
}

const isPositive = (value) => {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
};

/**
 * Names of the enrichment fields a transaction in `category` is missing, or an
 * empty array when the category doesn't require them. A ticker must contain a
 * letter (the same rule the portfolio key uses); quantity and price must be > 0.
 * A sell's quantity may be sent signed, so its magnitude is checked.
 */
export function missingInvestmentFields(category, { ticker, assetQuantity, assetPrice } = {}) {
  if (!requiresInvestmentEnrichment(category)) return [];
  const missing = [];
  if (typeof ticker !== 'string' || !/[a-zA-Z]/.test(ticker)) missing.push('ticker');
  const quantity = assetQuantity === null || assetQuantity === undefined || assetQuantity === ''
    ? assetQuantity
    : Math.abs(Number(assetQuantity));
  if (!isPositive(quantity)) missing.push('assetQuantity');
  if (!isPositive(assetPrice)) missing.push('assetPrice');
  return missing;
}

export function missingInvestmentFieldsError(category, missing) {
  return {
    error: `${category.name} transactions require ticker, assetQuantity and assetPrice (quantity and price greater than 0).`,
    missingFields: missing,
  };
}
