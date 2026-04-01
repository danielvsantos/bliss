const prisma = require('../../prisma/prisma');
const logger = require('./logger');
const { computeDescriptionHash } = require('./descriptionHash');

// ═══════════════════════════════════════════════════════════════════════════════
// DESCRIPTION → CATEGORY LOOKUP CACHE
//
// Per-tenant in-memory map of description hashes to categoryIds.
// Built from the DescriptionMapping table (hash-keyed, no encryption overhead).
// This is the "learning memory" of the system — every confirmed transaction
// teaches it via addDescriptionEntry() write-through.
//
// Lookup is O(1) — no looping, no DB query on the hot path.
// ═══════════════════════════════════════════════════════════════════════════════

// Map<tenantId, { lookupMap: Map<descriptionHash, categoryId>, refreshedAt: Date }>
const tenantDescriptionCache = new Map();

const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES_PER_TENANT = 25_000;    // Safety cap — prevents OOM from very large tenants

/**
 * Builds or refreshes the descriptionHash→categoryId lookup map for a tenant.
 * Reads from the DescriptionMapping table — a small, hash-keyed table with no
 * encryption overhead. Replaces the previous full Transaction table scan.
 *
 * @param {string} tenantId
 * @returns {Promise<Map<string, number>>} — Map of descriptionHash → categoryId
 */
async function buildLookupForTenant(tenantId) {
  const lookupMap = new Map();

  try {
    const rows = await prisma.descriptionMapping.findMany({
      where: { tenantId },
      select: { descriptionHash: true, categoryId: true },
    });

    for (const row of rows) {
      lookupMap.set(row.descriptionHash, row.categoryId);
    }

    // ─── Safety cap ──────────────────────────────────────────────────────────
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
      `Description cache built for tenant ${tenantId}: ${lookupMap.size} unique descriptions (from DescriptionMapping)`
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

  const hash = computeDescriptionHash(description);
  if (!hash) return null;

  const now = new Date();
  const cached = tenantDescriptionCache.get(tenantId);

  // Build cache if missing or stale
  if (!cached || now - cached.refreshedAt > REFRESH_INTERVAL) {
    const lookupMap = await buildLookupForTenant(tenantId);
    return lookupMap.get(hash) || null;
  }

  return cached.lookupMap.get(hash) || null;
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
 * for a tenant AND persists it to the DescriptionMapping table (fire-and-forget).
 * Called by categorizationService.recordFeedback() when a user overrides a category,
 * and by commitWorker after committing staged import rows.
 *
 * @param {string} description — Raw transaction description
 * @param {number} categoryId  — The corrected category ID
 * @param {string} tenantId
 */
function addDescriptionEntry(description, categoryId, tenantId) {
  if (!description || !categoryId || !tenantId) return;

  const hash = computeDescriptionHash(description);
  if (!hash) return;

  // In-memory update (immediate)
  const cached = tenantDescriptionCache.get(tenantId);
  if (cached) {
    cached.lookupMap.set(hash, categoryId);
  }

  // DB write-through (fire-and-forget)
  prisma.descriptionMapping.upsert({
    where: { tenantId_descriptionHash: { tenantId, descriptionHash: hash } },
    update: { categoryId },
    create: { tenantId, descriptionHash: hash, categoryId },
  }).catch((err) => {
    logger.warn(`DescriptionMapping upsert failed for tenant ${tenantId}: ${err.message}`);
  });
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
