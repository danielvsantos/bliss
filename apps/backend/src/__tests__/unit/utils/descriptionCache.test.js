// Mock prisma before requiring the module under test
jest.mock('../../../../prisma/prisma', () => ({
  transaction: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  plaidTransaction: {
    findMany: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  lookupDescription,
  warmDescriptionCache,
  addDescriptionEntry,
  invalidateDescriptionCache,
} = require('../../../utils/descriptionCache');

describe('descriptionCache', () => {
  beforeEach(async () => {
    // Warm the cache for tenant '1' with an empty DB (prisma returns [])
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
