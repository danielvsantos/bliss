import type { Category } from '@/types/api';
import type { ReviewItem } from '@/components/review/types';

// ── Investment enrichment detection ──────────────────────────────────────
// Centralises the logic that determines whether a transaction requires
// enrichment data (ticker, quantity, price) before it can be promoted.
//
// These sets MUST stay in sync with the backend workers and the
// deep-dive-drawer.tsx component (which uses the same constants inline).

/** Categories whose portfolio items are priced via external APIs — enrichment is MANDATORY. */
const INVESTMENT_HINTS_MANDATORY = new Set(['API_STOCK', 'API_CRYPTO', 'API_FUND']);

/** Categories whose assets are tracked manually — enrichment is OPTIONAL. */
const INVESTMENT_HINTS_OPTIONAL = new Set(['MANUAL']);

/**
 * True when the category requires mandatory investment enrichment
 * (ticker, quantity, price) before a transaction can be promoted.
 *
 * Applies to: Stocks, Crypto, Funds, ETFs, Commodities.
 */
export function isMandatoryEnrichmentCategory(category: Category | null | undefined): boolean {
  if (!category) return false;
  return category.type === 'Investments' && INVESTMENT_HINTS_MANDATORY.has(category.processingHint ?? '');
}

/**
 * True when the category is any investment type (mandatory or optional enrichment).
 */
export function isInvestmentCategory(category: Category | null | undefined): boolean {
  if (!category) return false;
  const hint = category.processingHint ?? '';
  return category.type === 'Investments' && (INVESTMENT_HINTS_MANDATORY.has(hint) || INVESTMENT_HINTS_OPTIONAL.has(hint));
}

/**
 * True when a ReviewItem needs enrichment before it can be quick-promoted/confirmed.
 *
 * Checks both the server-side `requiresEnrichment` flag AND the category
 * (belt-and-suspenders for cases where the flag hasn't been set yet, e.g.
 * the user just changed the category in the UI).
 */
export function itemNeedsEnrichment(
  item: ReviewItem,
  categoriesMap: Map<number, Category>,
): boolean {
  // Server already flagged this item
  if (item.requiresEnrichment) return true;
  // Category-based check (covers UI category changes before backend sync)
  if (!item.categoryId) return false;
  const cat = categoriesMap.get(item.categoryId);
  return isMandatoryEnrichmentCategory(cat);
}
