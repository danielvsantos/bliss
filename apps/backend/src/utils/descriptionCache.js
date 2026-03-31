const prisma = require('../../prisma/prisma');
const logger = require('./logger');

// ═══════════════════════════════════════════════════════════════════════════════
// DESCRIPTION → CATEGORY LOOKUP CACHE
//
// Per-tenant in-memory map of normalized transaction descriptions to categoryIds.
// Built from the Transaction table (confirmed/promoted transactions) and
// promoted PlaidTransactions. This is the "learning memory" of the system —
// every confirmed transaction teaches it.
//
// Lookup is O(1) — no looping, no DB query on the hot path.
// ═══════════════════════════════════════════════════════════════════════════════

// Map<tenantId, { lookupMap: Map<normalizedDesc, categoryId>, refreshedAt: Date }>
const tenantDescriptionCache = new Map();

const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes (descriptions change less often than categories)
const MAX_ENTRIES_PER_TENANT = 25_000;    // Safety cap — prevents OOM from very large tenants

/**
 * Builds or refreshes the description→categoryId lookup map for a tenant.
 * Sources:
 *   1. Transaction table — all non-manual transactions (PLAID, CSV) with confirmed categories
 *   2. PlaidTransaction table — promoted transactions with confirmed categories
 *
 * For duplicate descriptions with different categories, the most recent one wins.
 *
 * @param {string} tenantId
 * @returns {Promise<Map<string, number>>} — Map of normalizedDescription → categoryId
 */
async function buildLookupForTenant(tenantId) {
  const lookupMap = new Map();

  try {
    // ─── Source 1: Confirmed transactions (oldest first so newest overwrites) ───
    // Fetched in batches to stay within the Prisma Accelerate 5MB response limit.
    // Full history is the training corpus for exact-match classification.
    const BATCH_SIZE = 5000;
    let cursor = undefined;
    let totalFetched = 0;

    while (true) {
      const batch = await prisma.transaction.findMany({
        where: { tenantId },
        select: {
          id: true,
          description: true,
          categoryId: true,
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (batch.length === 0) break;

      for (const tx of batch) {
        if (tx.description && tx.categoryId) {
          const normalized = tx.description.trim().toLowerCase();
          if (normalized.length > 0) {
            lookupMap.set(normalized, tx.categoryId);
          }
        }
      }

      totalFetched += batch.length;
      cursor = batch[batch.length - 1].id;

      if (batch.length < BATCH_SIZE) break; // Last batch
    }

    // ─── Source 2: Promoted PlaidTransactions ──────────────────────────────────
    const promotedPlaid = await prisma.plaidTransaction.findMany({
      where: {
        promotionStatus: 'PROMOTED',
        suggestedCategoryId: { not: null },
        plaidItem: { tenantId },
      },
      select: {
        name: true,
        suggestedCategoryId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const pt of promotedPlaid) {
      if (pt.name && pt.suggestedCategoryId) {
        const normalized = pt.name.trim().toLowerCase();
        if (normalized.length > 0) {
          lookupMap.set(normalized, pt.suggestedCategoryId);
        }
      }
    }

    // ─── Safety cap: keep only the most recent entries if over limit ──────────
    // Because we iterate oldest-first, the Map already has newest-wins semantics.
    // To enforce the cap we keep the last MAX_ENTRIES_PER_TENANT entries (most
    // recent descriptions that were written last).
    if (lookupMap.size > MAX_ENTRIES_PER_TENANT) {
      const entries = [...lookupMap.entries()];
      const trimmed = new Map(entries.slice(entries.length - MAX_ENTRIES_PER_TENANT));
      lookupMap.clear();
      for (const [k, v] of trimmed) lookupMap.set(k, v);
      logger.warn(
        `Description cache for tenant ${tenantId} trimmed from ${entries.length} to ${MAX_ENTRIES_PER_TENANT} entries`
      );
    }

    tenantDescriptionCache.set(tenantId, {
      lookupMap,
      refreshedAt: new Date(),
    });

    logger.info(
      `Description cache built for tenant ${tenantId}: ${lookupMap.size} unique descriptions ` +
      `(from ${totalFetched} transactions + ${promotedPlaid.length} promoted Plaid)`
    );
  } catch (error) {
    logger.error(`Failed to build description cache for tenant ${tenantId}:`, error);

    // Return stale cache if available
    const stale = tenantDescriptionCache.get(tenantId);
    if (stale) {
      logger.warn(`Returning stale description cache for tenant ${tenantId}`);
      return stale.lookupMap;
    }
    return new Map();
  }

  return lookupMap;
}

/**
 * Looks up a description in the tenant's cache.
 * Returns the categoryId if found, or null if no match.
 *
 * @param {string} description — Raw transaction description
 * @param {string} tenantId
 * @returns {Promise<number|null>} — categoryId or null
 */
async function lookupDescription(description, tenantId) {
  if (!description || !tenantId) return null;

  const normalized = description.trim().toLowerCase();
  if (normalized.length === 0) return null;

  const now = new Date();
  const cached = tenantDescriptionCache.get(tenantId);

  // Build cache if missing or stale
  if (!cached || now - cached.refreshedAt > REFRESH_INTERVAL) {
    const lookupMap = await buildLookupForTenant(tenantId);
    return lookupMap.get(normalized) || null;
  }

  return cached.lookupMap.get(normalized) || null;
}

/**
 * Forces a cache rebuild for a tenant (e.g., after bulk import or user overrides).
 * @param {string} tenantId
 */
async function invalidateDescriptionCache(tenantId) {
  tenantDescriptionCache.delete(tenantId);
  logger.info(`Description cache invalidated for tenant ${tenantId}`);
}

/**
 * Pre-warms the cache for a tenant. Call this before batch processing.
 * @param {string} tenantId
 */
async function warmDescriptionCache(tenantId) {
  await buildLookupForTenant(tenantId);
}

/**
 * Immediately writes a description→categoryId mapping into the in-memory cache
 * for a tenant, without triggering a full DB rebuild.
 * Called by categorizationService.recordFeedback() when a user overrides a category.
 *
 * @param {string} description — Raw transaction description
 * @param {number} categoryId  — The corrected category ID
 * @param {string} tenantId
 */
function addDescriptionEntry(description, categoryId, tenantId) {
  if (!description || !categoryId || !tenantId) return;

  const normalized = description.trim().toLowerCase();
  if (normalized.length === 0) return;

  const cached = tenantDescriptionCache.get(tenantId);
  if (cached) {
    cached.lookupMap.set(normalized, categoryId);
    logger.info(`Description cache updated for tenant ${tenantId}: "${normalized}" → category ${categoryId}`);
  }
  // If the cache hasn't been warmed yet, the next lookupDescription call will
  // build it from DB (which already includes this override via Transaction record).
}

/**
 * Returns cache statistics for health monitoring.
 * @returns {{ tenantCount: number, totalEntries: number, maxEntriesPerTenant: number }}
 */
function getCacheStats() {
  let totalEntries = 0;
  for (const [, entry] of tenantDescriptionCache) {
    totalEntries += entry.lookupMap.size;
  }
  return {
    tenantCount: tenantDescriptionCache.size,
    totalEntries,
    maxEntriesPerTenant: MAX_ENTRIES_PER_TENANT,
  };
}

module.exports = {
  lookupDescription,
  invalidateDescriptionCache,
  warmDescriptionCache,
  addDescriptionEntry,
  getCacheStats,
};
