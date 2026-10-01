/**
 * System-managed fields for user-created (custom) categories.
 *
 * Users never choose `processingHint` / `portfolioItemKeyStrategy` (see
 * pages/api/categories.js), so they are derived from the category type.
 * Without this, a custom Investments or Debt category got `processingHint:
 * null` + `portfolioItemKeyStrategy: IGNORE`: its transactions saved fine but
 * no PortfolioItem was ever created, so it could never carry a value.
 *
 * The defaults mirror the built-in categories (lib/defaultCategories.js):
 *  - Investments → manually priced, one holding per description (Real Estate,
 *    Bonds, Pension Plan, …). Not TICKER: a ticker would create a SYNCED item,
 *    which skips the ManualAssetValue auto-seed.
 *  - Debt → simple liability, one item per category (Credit Card Debt).
 * Every other type tracks no holding.
 */

const NO_PORTFOLIO_TRACKING = Object.freeze({ processingHint: null, portfolioItemKeyStrategy: 'IGNORE' });

const DEFAULTS_BY_TYPE = Object.freeze({
  Investments: Object.freeze({ processingHint: 'MANUAL', portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION' }),
  Debt: Object.freeze({ processingHint: 'SIMPLE_LIABILITY', portfolioItemKeyStrategy: 'CATEGORY_NAME' }),
});

/** Hints a custom category can receive; deleting one is never system-critical. */
export const CUSTOM_CATEGORY_HINTS = Object.freeze(
  Object.values(DEFAULTS_BY_TYPE).map((d) => d.processingHint),
);

export function customCategorySystemFields(type) {
  return DEFAULTS_BY_TYPE[type] ?? NO_PORTFOLIO_TRACKING;
}

/**
 * System fields to write when a category's type changes, or null to leave
 * them alone. Only re-derived for custom categories whose current fields are
 * still the derived defaults of their old type — built-in categories and any
 * custom row whose fields were set some other way are never touched.
 */
export function systemFieldsForTypeChange(existing, newType) {
  if (!newType || newType === existing.type || existing.defaultCategoryCode) return null;
  const current = customCategorySystemFields(existing.type);
  const untouched = (existing.processingHint ?? null) === current.processingHint
    && existing.portfolioItemKeyStrategy === current.portfolioItemKeyStrategy;
  return untouched ? customCategorySystemFields(newType) : null;
}
