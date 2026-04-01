// Mock prisma before requiring the module under test
const mockUpsert = jest.fn().mockResolvedValue({});
jest.mock('../../../../prisma/prisma', () => ({
  descriptionMapping: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: mockUpsert,
  },
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../../../prisma/prisma');
const {
  lookupDescription,
  warmDescriptionCache,
  addDescriptionEntry,
  invalidateDescriptionCache,
} = require('../../../utils/descriptionCache');
const { computeDescriptionHash } = require('../../../utils/descriptionHash');

describe('descriptionCache', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockUpsert.mockResolvedValue({});
    prisma.descriptionMapping.findMany.mockResolvedValue([]);
    await invalidateDescriptionCache('1');
    await invalidateDescriptionCache('2');
  });

  describe('addDescriptionEntry()', () => {
    it('is a no-op when cache has not been warmed yet', () => {
      // Cache doesn't exist for tenant '99' — should not throw
      expect(() => addDescriptionEntry('Coffee Shop', 5, '99')).not.toThrow();
    });

    it('adds to cache immediately after warming', async () => {
      await warmDescriptionCache('1'); // builds empty cache from mocked prisma
      addDescriptionEntry('Coffee Shop', 7, '1');
      const result = await lookupDescription('Coffee Shop', '1');
      expect(result).toBe(7);
    });

    it('normalizes description to lowercase', async () => {
      await warmDescriptionCache('1');
      addDescriptionEntry('NETFLIX', 3, '1');
      const result = await lookupDescription('netflix', '1');
      expect(result).toBe(3);
    });

    it('trims whitespace on both add and lookup', async () => {
      await warmDescriptionCache('1');
      addDescriptionEntry('  Spotify  ', 4, '1');
      const result = await lookupDescription('spotify', '1');
      expect(result).toBe(4);
    });

    it('is a no-op when description is empty', async () => {
      await warmDescriptionCache('1');
      expect(() => addDescriptionEntry('', 5, '1')).not.toThrow();
    });

    it('is a no-op when categoryId is falsy', async () => {
      await warmDescriptionCache('1');
      expect(() => addDescriptionEntry('Coffee', null, '1')).not.toThrow();
    });

    it('upserts to DescriptionMapping table (fire-and-forget)', async () => {
      await warmDescriptionCache('1');
      addDescriptionEntry('Netflix', 3, '1');

      expect(prisma.descriptionMapping.upsert).toHaveBeenCalledWith({
        where: {
          tenantId_descriptionHash: {
            tenantId: '1',
            descriptionHash: computeDescriptionHash('Netflix'),
          },
        },
        update: { categoryId: 3 },
        create: {
          tenantId: '1',
          descriptionHash: computeDescriptionHash('Netflix'),
          categoryId: 3,
        },
      });
    });

    it('swallows upsert errors without throwing', async () => {
      mockUpsert.mockRejectedValueOnce(new Error('DB connection lost'));
      await warmDescriptionCache('1');
      // Should not throw
      expect(() => addDescriptionEntry('Coffee', 5, '1')).not.toThrow();
    });
  });

  describe('buildLookupForTenant()', () => {
    it('builds cache from DescriptionMapping table', async () => {
      const hash = computeDescriptionHash('Netflix');
      prisma.descriptionMapping.findMany.mockResolvedValueOnce([
        { descriptionHash: hash, categoryId: 3 },
      ]);

      await warmDescriptionCache('1');
      const result = await lookupDescription('Netflix', '1');
      expect(result).toBe(3);
    });
  });

  describe('tenant isolation', () => {
    it('entries for tenant 1 are not visible to tenant 2', async () => {
      await warmDescriptionCache('1');
      await warmDescriptionCache('2');
      addDescriptionEntry('Shared Merchant', 10, '1');
      const result = await lookupDescription('Shared Merchant', '2');
      expect(result).toBeNull();
    });
  });

  describe('lookupDescription()', () => {
    it('returns null for unknown description', async () => {
      await warmDescriptionCache('1');
      const result = await lookupDescription('Unknown Merchant XYZ', '1');
      expect(result).toBeNull();
    });

    it('returns null when description is empty', async () => {
      const result = await lookupDescription('', '1');
      expect(result).toBeNull();
    });

    it('returns null when tenantId is missing', async () => {
      const result = await lookupDescription('Something', null);
      expect(result).toBeNull();
    });
  });
});
