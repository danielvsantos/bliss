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

/** Mandatory hints that can be enriched without a ticker (private / unlisted funds). */
const TICKER_OPTIONAL_HINTS = new Set(['API_FUND']);

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

// Mirrors packages/shared/src/portfolio/enrichment.js (the web bundle doesn't
// depend on @bliss/shared) — keep the two in sync.

/** True when the hint needs a ticker on top of quantity + price. */
export function requiresTicker(processingHint: string | null | undefined): boolean {
  const hint = processingHint ?? '';
  return INVESTMENT_HINTS_MANDATORY.has(hint) && !TICKER_OPTIONAL_HINTS.has(hint);
}

type EnrichmentFields = {
  ticker?: string | null;
  assetQuantity?: string | number | null;
  assetPrice?: string | number | null;
};

/**
 * True when `row` carries everything its category needs: quantity + price,
 * plus a ticker (with at least one letter) unless the category is a fund.
 * Categories that don't require enrichment are always complete.
 */
export function isInvestmentEnrichmentComplete(
  category: Category | null | undefined,
  row: EnrichmentFields | null | undefined,
): boolean {
  if (!isMandatoryEnrichmentCategory(category)) return true;
  const present = (v: unknown) => v !== null && v !== undefined && v !== '';
  if (!present(row?.assetQuantity) || !present(row?.assetPrice)) return false;
  return !requiresTicker(category!.processingHint) || /[a-zA-Z]/.test(row?.ticker ?? '');
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
  if (!isMandatoryEnrichmentCategory(cat)) return false;
  // Row already carries enrichment data (e.g. native-adapter CSV imports that
  // supply ticker/quantity/price directly) — nothing left to fill in, so Approve
  // stays open. Shared rule: the ticker is optional for funds (API_FUND).
  const row = item.originalImportRow;
  return !(row && isInvestmentEnrichmentComplete(cat, row));
}

/**
 * True when an import row has no account assigned yet.
 *
 * Native-adapter (Bliss Native CSV) imports resolve `accountId` per row from
 * the sheet's own account column/ID and can leave it unresolved (typo,
 * renamed account, etc.). `Transaction.accountId` is a required column, so
 * such a row can never be committed until the user assigns one via the
 * deep-dive drawer's account selector. Plaid items always have an account
 * (established at Plaid Link connect time, before any transaction syncs),
 * so this is only ever true for import-sourced items.
 */
export function itemNeedsAccount(item: ReviewItem): boolean {
  return item.source === 'import' && !item.originalImportRow?.accountId;
}

/**
 * True when a ReviewItem cannot be quick-promoted/confirmed as-is and must
 * go through the deep-dive drawer first — either it's missing an account or
 * it needs investment enrichment. This is the single predicate both the
 * Transaction Review and Smart Import pages should use to gate Approve;
 * don't hand-roll either check inline, they've drifted out of sync before.
 */
export function itemNeedsReview(
  item: ReviewItem,
  categoriesMap: Map<number, Category>,
): boolean {
  return itemNeedsAccount(item) || itemNeedsEnrichment(item, categoriesMap);
}
