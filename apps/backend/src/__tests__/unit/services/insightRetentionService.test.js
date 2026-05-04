// ─── insightRetentionService.test.js ────────────────────────────────────────

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockDeleteMany = jest.fn();
const mockGroupBy = jest.fn();
const mockCount = jest.fn();

jest.mock('../../../../prisma/prisma.js', () => ({
  insight: {
    deleteMany: (...args) => mockDeleteMany(...args),
    groupBy: (...args) => mockGroupBy(...args),
    count: (...args) => mockCount(...args),
  },
}));

const {
  cleanupExpiredInsights,
  getRetentionStats,
} = require('../../../services/insightRetentionService');
const logger = require('../../../utils/logger');

describe('insightRetentionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('cleanupExpiredInsights()', () => {
    it('deletes insights where expiresAt < now', async () => {
      mockDeleteMany.mockResolvedValue({ count: 5 });

      const result = await cleanupExpiredInsights();

      expect(mockDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: expect.objectContaining({
              not: null,
              lt: expect.any(Date),
            }),
          }),
        })
      );
      expect(result).toBe(5);
    });

    it('logs when insights are deleted', async () => {
      mockDeleteMany.mockResolvedValue({ count: 3 });
      await cleanupExpiredInsights();
      expect(logger.info).toHaveBeenCalledWith(
        'Expired insights cleaned up:',
        expect.objectContaining({ deletedCount: 3 })
      );
    });

    it('does NOT log when no insights are deleted', async () => {
      mockDeleteMany.mockResolvedValue({ count: 0 });
      await cleanupExpiredInsights();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('returns 0 when no insights were deleted', async () => {
      mockDeleteMany.mockResolvedValue({ count: 0 });
      const result = await cleanupExpiredInsights();
      expect(result).toBe(0);
    });
  });

  describe('getRetentionStats()', () => {
    it('returns grouped tier stats and expired count', async () => {
      mockGroupBy.mockResolvedValue([
        { tier: 'MONTHLY', _count: { id: 12 }, _min: { createdAt: new Date('2026-01-01') }, _max: { createdAt: new Date('2026-04-01') } },
        { tier: 'ANNUAL',  _count: { id: 2 },  _min: { createdAt: new Date('2025-01-01') }, _max: { createdAt: new Date('2026-01-01') } },
      ]);
      mockCount.mockResolvedValue(1);

      const stats = await getRetentionStats('tenant-1');

      expect(stats.byTier).toHaveLength(2);
      expect(stats.byTier[0]).toEqual({
        tier: 'MONTHLY',
        count: 12,
        oldest: expect.any(Date),
        newest: expect.any(Date),
      });
      expect(stats.expiredCount).toBe(1);
    });

    it('returns empty byTier array when no insights exist', async () => {
      mockGroupBy.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);

      const stats = await getRetentionStats('tenant-empty');

      expect(stats.byTier).toEqual([]);
      expect(stats.expiredCount).toBe(0);
    });

    it('calls groupBy with the correct tenantId filter', async () => {
      mockGroupBy.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);

      await getRetentionStats('my-tenant');

      expect(mockGroupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'my-tenant' },
        })
      );
    });

    it('calls count with tenantId and expiresAt filter', async () => {
      mockGroupBy.mockResolvedValue([]);
      mockCount.mockResolvedValue(2);

      await getRetentionStats('my-tenant');

      expect(mockCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'my-tenant',
            expiresAt: expect.objectContaining({
              not: null,
              lt: expect.any(Date),
            }),
          }),
        })
      );
    });
  });
});
