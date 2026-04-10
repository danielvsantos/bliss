jest.mock('../../../../prisma/prisma', () => ({
  transaction: {
    findMany: jest.fn(),
  },
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../../../prisma/prisma');
const { computeTransactionHash, buildDuplicateHashSet } = require('../../../utils/transactionHash');

describe('transactionHash', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('computeTransactionHash()', () => {
    it('produces a 64-char hex SHA-256 hash', () => {
      const hash = computeTransactionHash('2024-03-15', 'Coffee Shop', 4.50, 1);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic — same inputs produce same hash', () => {
      const a = computeTransactionHash('2024-03-15', 'Coffee Shop', 4.50, 1);
      const b = computeTransactionHash('2024-03-15', 'Coffee Shop', 4.50, 1);
      expect(a).toBe(b);
    });

    it('normalizes description to lowercase trimmed', () => {
      const a = computeTransactionHash('2024-03-15', '  Coffee Shop  ', 4.50, 1);
      const b = computeTransactionHash('2024-03-15', 'coffee shop', 4.50, 1);
      expect(a).toBe(b);
    });

    it('extracts UTC date components from Date objects', () => {
      // Both should produce the same hash since they represent the same UTC date
      const dateObj = new Date('2024-03-15T00:00:00.000Z');
      const dateStr = '2024-03-15';
      const a = computeTransactionHash(dateObj, 'test', 10, 1);
      const b = computeTransactionHash(dateStr, 'test', 10, 1);
      expect(a).toBe(b);
    });

    it('different amounts produce different hashes', () => {
      const a = computeTransactionHash('2024-03-15', 'test', 10, 1);
      const b = computeTransactionHash('2024-03-15', 'test', 20, 1);
      expect(a).not.toBe(b);
    });

    it('different accountIds produce different hashes', () => {
      const a = computeTransactionHash('2024-03-15', 'test', 10, 1);
      const b = computeTransactionHash('2024-03-15', 'test', 10, 2);
      expect(a).not.toBe(b);
    });
  });

  describe('buildDuplicateHashSet()', () => {
    it('returns a Set of hashes from existing transactions', async () => {
      prisma.transaction.findMany.mockResolvedValue([
        { transaction_date: new Date('2024-03-15'), description: 'Coffee', credit: null, debit: 4.50, accountId: 1 },
        { transaction_date: new Date('2024-03-16'), description: 'Lunch', credit: null, debit: 12.00, accountId: 1 },
      ]);

      const hashSet = await buildDuplicateHashSet('tenant1', 1);
      expect(hashSet).toBeInstanceOf(Set);
      expect(hashSet.size).toBe(2);
    });

    it('uses 90-day default window when no dates provided', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      await buildDuplicateHashSet('tenant1', 1);

      const call = prisma.transaction.findMany.mock.calls[0][0];
      expect(call.where.transaction_date.gte).toBeDefined();
      expect(call.where.transaction_date.lte).toBeUndefined();
    });

    it('applies both gte and lte when minDate and maxDate are provided', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      const minDate = new Date('2010-11-12T00:00:00.000Z');
      const maxDate = new Date('2010-11-12T00:00:00.000Z');

      await buildDuplicateHashSet('tenant1', 1, minDate, maxDate);

      const call = prisma.transaction.findMany.mock.calls[0][0];
      expect(call.where.transaction_date.gte).toBeDefined();
      expect(call.where.transaction_date.lte).toBeDefined();

      // dateFloor should be minDate - 1 day
      const expectedFloor = new Date('2010-11-11T00:00:00.000Z');
      expect(call.where.transaction_date.gte.toISOString()).toBe(expectedFloor.toISOString());

      // dateCeiling should be maxDate + 1 day
      const expectedCeiling = new Date('2010-11-13T00:00:00.000Z');
      expect(call.where.transaction_date.lte.toISOString()).toBe(expectedCeiling.toISOString());
    });

    it('uses minDate - 1 day as floor when minDate is within 90 days', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 30);

      await buildDuplicateHashSet('tenant1', 1, recentDate, recentDate);

      const call = prisma.transaction.findMany.mock.calls[0][0];
      const floorDate = call.where.transaction_date.gte;
      // Floor should be minDate - 1 day (buffer), not 90 days ago
      const expectedFloor = new Date(recentDate);
      expectedFloor.setDate(expectedFloor.getDate() - 1);
      expect(floorDate.toISOString().slice(0, 10)).toBe(expectedFloor.toISOString().slice(0, 10));
    });

    it('applies maxDate ceiling even when minDate is recent', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 10);

      await buildDuplicateHashSet('tenant1', 1, recentDate, recentDate);

      const call = prisma.transaction.findMany.mock.calls[0][0];
      // Should have an upper bound
      expect(call.where.transaction_date.lte).toBeDefined();
    });

    it('uses credit when debit is null', async () => {
      const creditTx = { transaction_date: new Date('2024-03-15'), description: 'Salary', credit: 5000, debit: null, accountId: 1 };
      prisma.transaction.findMany.mockResolvedValue([creditTx]);

      const hashSet = await buildDuplicateHashSet('tenant1', 1);
      const expectedHash = computeTransactionHash(creditTx.transaction_date, 'Salary', 5000, 1);
      expect(hashSet.has(expectedHash)).toBe(true);
    });
  });
});
