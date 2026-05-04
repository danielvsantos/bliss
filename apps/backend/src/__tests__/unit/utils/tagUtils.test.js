// ─── tagUtils.test.js ───────────────────────────────────────────────────────
// Unit tests for resolveTagsByName() helper.

const mockTagFindFirst = jest.fn();
const mockTagCreate = jest.fn();

jest.mock('../../../../prisma/prisma', () => ({
  tag: {
    findFirst: (...args) => mockTagFindFirst(...args),
    create: (...args) => mockTagCreate(...args),
  },
}));

const { resolveTagsByName } = require('../../../utils/tagUtils');

describe('resolveTagsByName()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('early-return cases', () => {
    it('returns empty array when tagNames is null', async () => {
      const result = await resolveTagsByName(null, 'tenant-1', 'user@test.com');
      expect(result).toEqual([]);
    });

    it('returns empty array when tagNames is undefined', async () => {
      const result = await resolveTagsByName(undefined, 'tenant-1', 'user@test.com');
      expect(result).toEqual([]);
    });

    it('returns empty array when tagNames is not an array', async () => {
      const result = await resolveTagsByName('Travel', 'tenant-1', 'user@test.com');
      expect(result).toEqual([]);
    });

    it('returns empty array when tagNames is an empty array', async () => {
      const result = await resolveTagsByName([], 'tenant-1', 'user@test.com');
      expect(result).toEqual([]);
    });
  });

  describe('finding existing tags', () => {
    it('returns existing tag when found by name', async () => {
      mockTagFindFirst.mockResolvedValue({ id: 1, name: 'Travel' });

      const result = await resolveTagsByName(['Travel'], 'tenant-1', 'user@test.com');

      expect(result).toEqual([{ id: 1, name: 'Travel' }]);
      expect(mockTagFindFirst).toHaveBeenCalledWith({
        where: { name: 'Travel', tenantId: 'tenant-1' },
      });
      expect(mockTagCreate).not.toHaveBeenCalled();
    });

    it('resolves multiple tags', async () => {
      mockTagFindFirst
        .mockResolvedValueOnce({ id: 1, name: 'Travel' })
        .mockResolvedValueOnce({ id: 2, name: 'Business' });

      const result = await resolveTagsByName(['Travel', 'Business'], 'tenant-1', 'user@test.com');

      expect(result).toEqual([
        { id: 1, name: 'Travel' },
        { id: 2, name: 'Business' },
      ]);
    });
  });

  describe('creating new tags', () => {
    it('creates a new tag when not found', async () => {
      mockTagFindFirst.mockResolvedValue(null);
      mockTagCreate.mockResolvedValue({ id: 3, name: 'Vacation' });

      const result = await resolveTagsByName(['Vacation'], 'tenant-1', 'user@test.com');

      expect(result).toEqual([{ id: 3, name: 'Vacation' }]);
      expect(mockTagCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Vacation',
            tenantId: 'tenant-1',
          }),
        })
      );
    });

    it('generates a color for newly created tags', async () => {
      mockTagFindFirst.mockResolvedValue(null);
      mockTagCreate.mockResolvedValue({ id: 5, name: 'NewTag' });

      await resolveTagsByName(['NewTag'], 'tenant-1', 'user@test.com');

      const createCall = mockTagCreate.mock.calls[0][0];
      expect(createCall.data.color).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('race condition handling (P2002)', () => {
    it('handles P2002 duplicate key error by falling back to findFirst', async () => {
      mockTagFindFirst
        .mockResolvedValueOnce(null)             // initial lookup: not found
        .mockResolvedValueOnce({ id: 7, name: 'Racing' }); // post-error lookup: found
      const p2002Error = new Error('Unique constraint failed');
      p2002Error.code = 'P2002';
      mockTagCreate.mockRejectedValue(p2002Error);

      const result = await resolveTagsByName(['Racing'], 'tenant-1', 'user@test.com');

      expect(result).toEqual([{ id: 7, name: 'Racing' }]);
      expect(mockTagFindFirst).toHaveBeenCalledTimes(2);
    });

    it('rethrows non-P2002 errors from tag create', async () => {
      mockTagFindFirst.mockResolvedValue(null);
      const dbError = new Error('DB connection lost');
      dbError.code = 'P1001';
      mockTagCreate.mockRejectedValue(dbError);

      await expect(resolveTagsByName(['NewTag'], 'tenant-1', 'user@test.com')).rejects.toThrow(
        'DB connection lost'
      );
    });
  });

  describe('edge cases', () => {
    it('skips empty string tag names', async () => {
      const result = await resolveTagsByName(['', '  ', 'Valid'], 'tenant-1', 'user@test.com');

      // Only 'Valid' should be processed
      expect(mockTagFindFirst).toHaveBeenCalledTimes(1);
      expect(mockTagFindFirst).toHaveBeenCalledWith({
        where: { name: 'Valid', tenantId: 'tenant-1' },
      });
    });

    it('trims whitespace from tag names', async () => {
      mockTagFindFirst.mockResolvedValue({ id: 1, name: 'Travel' });

      await resolveTagsByName(['  Travel  '], 'tenant-1', 'user@test.com');

      expect(mockTagFindFirst).toHaveBeenCalledWith({
        where: { name: 'Travel', tenantId: 'tenant-1' },
      });
    });

    it('skips non-string entries gracefully', async () => {
      // Non-string values should produce empty string after trim and be skipped
      const result = await resolveTagsByName([123, null, 'Valid'], 'tenant-1', 'user@test.com');

      // 123 → '' (from `typeof 123 !== 'string'` → ''), null → '' — both skipped
      // Only 'Valid' is processed
      expect(mockTagFindFirst).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when all tag names are empty after trimming', async () => {
      const result = await resolveTagsByName(['  ', '', '   '], 'tenant-1', 'user@test.com');
      expect(result).toEqual([]);
      expect(mockTagFindFirst).not.toHaveBeenCalled();
    });
  });
});
