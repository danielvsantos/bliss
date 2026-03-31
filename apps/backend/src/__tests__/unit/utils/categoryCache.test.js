// ─── categoryCache.test.js ───────────────────────────────────────────────────
// Unit tests for tenant-scoped category caching and legacy global getCategoryMaps.

jest.mock('../../../../prisma/prisma', () => ({
  category: { findMany: jest.fn() },
}));
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../../../prisma/prisma');
const {
  getCategoriesForTenant,
  invalidateTenantCategories,
  clearAllTenantCaches,
  getCategoryMaps,
  refreshCategoryCache,
} = require('../../../utils/categoryCache');

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('categoryCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    // Reset module-level state between tests
    clearAllTenantCaches();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── Tenant-scoped cache ─────────────────────────────────────────────────

  describe('getCategoriesForTenant', () => {
    const TENANT_ID = 'tenant-abc';
    const mockCategories = [
      { id: 1, name: 'Groceries', group: 'Food', type: 'EXPENSE', processingHint: null },
      { id: 2, name: 'Salary', group: 'Income', type: 'INCOME', processingHint: null },
    ];

    // 1. getCategoriesForTenant fetches from Prisma on first call
    it('fetches from Prisma on first call', async () => {
      prisma.category.findMany.mockResolvedValue(mockCategories);

      const result = await getCategoriesForTenant(TENANT_ID);

      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.category.findMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID },
        select: {
          id: true,
          name: true,
          group: true,
          type: true,
          processingHint: true,
        },
      });
      expect(result).toEqual(mockCategories);
    });

    // 2. getCategoriesForTenant returns cached data within REFRESH_INTERVAL
    it('returns cached data within REFRESH_INTERVAL without re-fetching', async () => {
      prisma.category.findMany.mockResolvedValue(mockCategories);

      // First call — populates cache
      await getCategoriesForTenant(TENANT_ID);
      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);

      // Advance time by 2 minutes (well within 5 min TTL)
      jest.advanceTimersByTime(2 * 60 * 1000);

      // Second call — should return cached result
      const result = await getCategoriesForTenant(TENANT_ID);

      expect(prisma.category.findMany).toHaveBeenCalledTimes(1); // no second call
      expect(result).toEqual(mockCategories);
    });

    // 3. getCategoriesForTenant re-fetches after REFRESH_INTERVAL expires
    it('re-fetches from Prisma after REFRESH_INTERVAL expires', async () => {
      const updatedCategories = [
        ...mockCategories,
        { id: 3, name: 'Rent', group: 'Housing', type: 'EXPENSE', processingHint: null },
      ];

      prisma.category.findMany
        .mockResolvedValueOnce(mockCategories)
        .mockResolvedValueOnce(updatedCategories);

      // First call — populates cache
      await getCategoriesForTenant(TENANT_ID);
      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);

      // Advance time past 5-minute TTL
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Second call — cache is stale, should re-fetch
      const result = await getCategoriesForTenant(TENANT_ID);

      expect(prisma.category.findMany).toHaveBeenCalledTimes(2);
      expect(result).toEqual(updatedCategories);
    });

    // 4. getCategoriesForTenant returns stale cache on Prisma error
    it('returns stale cache on Prisma error', async () => {
      prisma.category.findMany
        .mockResolvedValueOnce(mockCategories)
        .mockRejectedValueOnce(new Error('DB connection lost'));

      // First call — populates cache
      await getCategoriesForTenant(TENANT_ID);

      // Advance past TTL so cache is stale
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Second call — Prisma throws, should return stale data
      const result = await getCategoriesForTenant(TENANT_ID);

      expect(result).toEqual(mockCategories);
    });

    // 5. getCategoriesForTenant returns empty array on error if no cache
    it('returns empty array on error if no cache exists', async () => {
      prisma.category.findMany.mockRejectedValue(new Error('DB unreachable'));

      const result = await getCategoriesForTenant(TENANT_ID);

      expect(result).toEqual([]);
    });
  });

  // ─── invalidateTenantCategories ──────────────────────────────────────────

  describe('invalidateTenantCategories', () => {
    const TENANT_ID = 'tenant-xyz';
    const mockCategories = [
      { id: 10, name: 'Travel', group: 'Travel', type: 'EXPENSE', processingHint: null },
    ];

    // 6. invalidateTenantCategories removes tenant from cache
    it('removes tenant from cache', async () => {
      prisma.category.findMany.mockResolvedValue(mockCategories);

      // Populate cache
      await getCategoriesForTenant(TENANT_ID);
      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);

      // Invalidate
      invalidateTenantCategories(TENANT_ID);

      // Next call must re-fetch even though TTL has not expired
      prisma.category.findMany.mockResolvedValue(mockCategories);
      await getCategoriesForTenant(TENANT_ID);

      expect(prisma.category.findMany).toHaveBeenCalledTimes(2);
    });

    // 7. invalidateTenantCategories forces re-fetch on next call
    it('forces re-fetch with fresh data on next call', async () => {
      const freshCategories = [
        { id: 20, name: 'Utilities', group: 'Bills', type: 'EXPENSE', processingHint: null },
      ];

      prisma.category.findMany
        .mockResolvedValueOnce(mockCategories)
        .mockResolvedValueOnce(freshCategories);

      // Populate cache
      const first = await getCategoriesForTenant(TENANT_ID);
      expect(first).toEqual(mockCategories);

      // Invalidate and re-fetch
      invalidateTenantCategories(TENANT_ID);
      const second = await getCategoriesForTenant(TENANT_ID);

      expect(second).toEqual(freshCategories);
    });
  });

  // ─── clearAllTenantCaches ────────────────────────────────────────────────

  describe('clearAllTenantCaches', () => {
    // 8. clearAllTenantCaches empties entire cache
    it('empties entire cache forcing re-fetch for all tenants', async () => {
      const cats1 = [{ id: 1, name: 'A', group: 'G1', type: 'EXPENSE', processingHint: null }];
      const cats2 = [{ id: 2, name: 'B', group: 'G2', type: 'INCOME', processingHint: null }];

      prisma.category.findMany
        .mockResolvedValueOnce(cats1)  // tenant-1 first fetch
        .mockResolvedValueOnce(cats2)  // tenant-2 first fetch
        .mockResolvedValueOnce(cats1)  // tenant-1 re-fetch after clear
        .mockResolvedValueOnce(cats2); // tenant-2 re-fetch after clear

      // Populate both
      await getCategoriesForTenant('tenant-1');
      await getCategoriesForTenant('tenant-2');
      expect(prisma.category.findMany).toHaveBeenCalledTimes(2);

      // Clear all
      clearAllTenantCaches();

      // Both tenants must re-fetch
      await getCategoriesForTenant('tenant-1');
      await getCategoriesForTenant('tenant-2');
      expect(prisma.category.findMany).toHaveBeenCalledTimes(4);
    });
  });

  // ─── Legacy global cache ────────────────────────────────────────────────

  describe('getCategoryMaps', () => {
    const globalCategories = [
      { group: 'Food', type: 'EXPENSE', processingHint: 'API_STOCK' },
      { group: 'Income', type: 'INCOME', processingHint: null },
      { group: 'Crypto', type: 'ASSET', processingHint: 'API_CRYPTO' },
    ];

    beforeEach(() => {
      // lastGlobalRefresh is module-level state not cleared by clearAllTenantCaches().
      // Advance the fake clock past the REFRESH_INTERVAL so any lingering
      // lastGlobalRefresh from a prior test is guaranteed to be expired.
      jest.advanceTimersByTime(10 * 60 * 1000);
    });

    // 9. getCategoryMaps calls refreshCategoryCache on first invocation
    it('calls Prisma (via refreshCategoryCache) on first invocation', async () => {
      prisma.category.findMany.mockResolvedValue(globalCategories);

      const maps = await getCategoryMaps();

      // refreshCategoryCache calls prisma.category.findMany({ take: 50000 })
      expect(prisma.category.findMany).toHaveBeenCalledWith({ take: 50000 });
      expect(maps.groupToTypeMap).toBeInstanceOf(Map);
      expect(maps.groupToHintMap).toBeInstanceOf(Map);
    });

    // 10. getCategoryMaps returns Maps from cached global data
    it('returns populated Maps from cached global data without re-fetching', async () => {
      prisma.category.findMany.mockResolvedValue(globalCategories);

      // Directly call refreshCategoryCache to populate global maps and set lastGlobalRefresh
      await refreshCategoryCache();
      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);

      // getCategoryMaps within TTL — should use cached maps, no second Prisma call
      const maps = await getCategoryMaps();
      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);

      // Verify map contents
      expect(maps.groupToTypeMap.get('Food')).toBe('EXPENSE');
      expect(maps.groupToTypeMap.get('Income')).toBe('INCOME');
      expect(maps.groupToTypeMap.get('Crypto')).toBe('ASSET');
      expect(maps.groupToHintMap.get('Food')).toBe('API_STOCK');
      expect(maps.groupToHintMap.get('Income')).toBeNull();
      expect(maps.groupToHintMap.get('Crypto')).toBe('API_CRYPTO');
    });
  });
});
