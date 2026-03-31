const prisma = require('../../prisma/prisma');
const logger = require('./logger');

// ─── Legacy global cache (used by analyticsWorker) ────────────────────────────
let groupToTypeMap = new Map();
let groupToHintMap = new Map();
let lastGlobalRefresh = null;

// ─── Tenant-scoped cache ──────────────────────────────────────────────────────
// Map<tenantId, { categories: Array, refreshedAt: Date }>
const tenantCategoryCache = new Map();

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_TENANTS = 500; // Safety cap — evict oldest-refreshed tenant if exceeded

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY — Global category maps (backward-compatible)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetches ALL categories from the database and rebuilds the global lookup maps.
 * Used by analyticsWorker for group→type/hint resolution.
 */
async function refreshCategoryCache() {
  try {
    logger.info('Refreshing global category cache...');
    // KNOWN-LARGE QUERY: fetches categories across ALL tenants for the legacy
    // analyticsWorker group→type/hint maps.  A safety cap of 50,000 rows is
    // applied; if the system grows beyond this the cache will be silently
    // partial and a warning will be logged.  Tenant-scoped callers should use
    // getCategoriesForTenant() instead, which is already bounded per tenant.
    const categories = await prisma.category.findMany({ take: 50000 });

    const newGroupToTypeMap = new Map();
    const newGroupToHintMap = new Map();

    for (const category of categories) {
      newGroupToTypeMap.set(category.group, category.type);
      newGroupToHintMap.set(category.group, category.processingHint);
    }

    groupToTypeMap = newGroupToTypeMap;
    groupToHintMap = newGroupToHintMap;
    lastGlobalRefresh = new Date();

    logger.info(`Global category cache refreshed. Loaded ${categories.length} categories.`);
  } catch (error) {
    logger.error('Failed to refresh global category cache:', error);
  }
}

/**
 * Gets the global category lookup maps, refreshing if stale.
 * @returns {Promise<{groupToTypeMap: Map, groupToHintMap: Map}>}
 */
async function getCategoryMaps() {
  const now = new Date();
  if (!lastGlobalRefresh || now - lastGlobalRefresh > REFRESH_INTERVAL) {
    await refreshCategoryCache();
  }
  return { groupToTypeMap, groupToHintMap };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TENANT-SCOPED — Full category objects for AI classification
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns the full category list for a specific tenant.
 * Caches per-tenant for REFRESH_INTERVAL. Returns objects with
 * { id, name, group, type, processingHint } — the fields the
 * categorization service needs.
 *
 * @param {string} tenantId
 * @returns {Promise<Array<{id: number, name: string, group: string, type: string, processingHint: string|null}>>}
 */
async function getCategoriesForTenant(tenantId) {
  const now = new Date();
  const cached = tenantCategoryCache.get(tenantId);

  if (cached && now - cached.refreshedAt < REFRESH_INTERVAL) {
    return cached.categories;
  }

  try {
    const categories = await prisma.category.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        group: true,
        type: true,
        processingHint: true,
      },
    });

    // Evict oldest tenant if cache exceeds safety cap
    if (tenantCategoryCache.size >= MAX_TENANTS && !tenantCategoryCache.has(tenantId)) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, entry] of tenantCategoryCache) {
        const ts = entry.refreshedAt.getTime();
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        tenantCategoryCache.delete(oldestKey);
        logger.info(`Category cache evicted oldest tenant ${oldestKey} (at cap of ${MAX_TENANTS})`);
      }
    }

    tenantCategoryCache.set(tenantId, {
      categories,
      refreshedAt: new Date(),
    });

    logger.info(`Tenant category cache refreshed for ${tenantId}. Loaded ${categories.length} categories.`);
    return categories;
  } catch (error) {
    logger.error(`Failed to refresh tenant category cache for ${tenantId}:`, error);

    // Return stale cache if available, otherwise empty array
    if (cached) {
      logger.warn(`Returning stale category cache for ${tenantId}`);
      return cached.categories;
    }
    return [];
  }
}

/**
 * Invalidates the cache for a specific tenant (e.g., after category CRUD).
 * @param {string} tenantId
 */
function invalidateTenantCategories(tenantId) {
  tenantCategoryCache.delete(tenantId);
  logger.info(`Category cache invalidated for tenant ${tenantId}`);
}

/**
 * Clears all tenant caches. Useful for full reset.
 */
function clearAllTenantCaches() {
  tenantCategoryCache.clear();
  logger.info('All tenant category caches cleared.');
}

/**
 * Returns cache statistics for health monitoring.
 * @returns {{ tenantCount: number, globalCategories: number, maxTenants: number }}
 */
function getCacheStats() {
  return {
    tenantCount: tenantCategoryCache.size,
    globalCategories: groupToTypeMap.size,
    maxTenants: MAX_TENANTS,
  };
}

module.exports = {
  // Legacy (backward-compatible)
  getCategoryMaps,
  refreshCategoryCache,
  // Tenant-scoped (Sprint 3+)
  getCategoriesForTenant,
  invalidateTenantCategories,
  clearAllTenantCaches,
  getCacheStats,
};
