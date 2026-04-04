import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma before importing the module under test
vi.mock('../../../prisma/prisma.js', () => ({
  default: {
    transaction: {
      findMany: vi.fn(),
    },
  },
}));

import { computeTransactionHash, buildDuplicateHashSet } from '../../../utils/transactionHash.js';
import prisma from '../../../prisma/prisma.js';

describe('transactionHash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('computeTransactionHash()', () => {
    it('produces consistent hash for the same inputs', () => {
      const hash1 = computeTransactionHash('2024-01-15', 'Coffee Shop', 4.50, 1);
      const hash2 = computeTransactionHash('2024-01-15', 'Coffee Shop', 4.50, 1);
      expect(hash1).toBe(hash2);
    });

    it('different inputs produce different hashes', () => {
      const hash1 = computeTransactionHash('2024-01-15', 'Coffee Shop', 4.50, 1);
      const hash2 = computeTransactionHash('2024-01-16', 'Coffee Shop', 4.50, 1);
      const hash3 = computeTransactionHash('2024-01-15', 'Tea House', 4.50, 1);
      const hash4 = computeTransactionHash('2024-01-15', 'Coffee Shop', 5.00, 1);
      const hash5 = computeTransactionHash('2024-01-15', 'Coffee Shop', 4.50, 2);

      const hashes = [hash1, hash2, hash3, hash4, hash5];
      const unique = new Set(hashes);
      expect(unique.size).toBe(5);
    });

    it('returns a 64-char hex string', () => {
      const hash = computeTransactionHash('2024-01-15', 'Test', 10, 1);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('normalizes Date objects to UTC YYYY-MM-DD', () => {
      const dateObj = new Date('2024-06-15T14:30:00Z');
      const dateStr = '2024-06-15';
      const hashFromObj = computeTransactionHash(dateObj, 'Test', 10, 1);
      const hashFromStr = computeTransactionHash(dateStr, 'Test', 10, 1);
      expect(hashFromObj).toBe(hashFromStr);
    });

    it('normalizes description: trim and lowercase', () => {
      const hash1 = computeTransactionHash('2024-01-15', '  Coffee Shop  ', 4.50, 1);
      const hash2 = computeTransactionHash('2024-01-15', 'coffee shop', 4.50, 1);
      expect(hash1).toBe(hash2);
    });

    it('normalizes amount via parseFloat', () => {
      const hash1 = computeTransactionHash('2024-01-15', 'Test', '4.50', 1);
      const hash2 = computeTransactionHash('2024-01-15', 'Test', 4.5, 1);
      expect(hash1).toBe(hash2);
    });

    it('handles null description gracefully', () => {
      const hash = computeTransactionHash('2024-01-15', null as any, 10, 1);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('handles undefined description gracefully', () => {
      const hash = computeTransactionHash('2024-01-15', undefined as any, 10, 1);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('null and undefined description produce the same hash', () => {
      const hash1 = computeTransactionHash('2024-01-15', null as any, 10, 1);
      const hash2 = computeTransactionHash('2024-01-15', undefined as any, 10, 1);
      expect(hash1).toBe(hash2);
    });
  });

  describe('buildDuplicateHashSet()', () => {
    it('returns a Set of hashes from DB transactions', async () => {
      const mockTxs = [
        { transaction_date: new Date('2024-01-15'), description: 'Coffee', credit: null, debit: 4.50, accountId: 1 },
        { transaction_date: new Date('2024-01-16'), description: 'Groceries', credit: null, debit: 55.00, accountId: 1 },
      ];
      vi.mocked(prisma.transaction.findMany).mockResolvedValue(mockTxs as any);

      const result = await buildDuplicateHashSet('tenant-1', 1);

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(2);

      // Verify the hashes match what computeTransactionHash would produce
      const expectedHash1 = computeTransactionHash(new Date('2024-01-15'), 'Coffee', 4.50, 1);
      const expectedHash2 = computeTransactionHash(new Date('2024-01-16'), 'Groceries', 55.00, 1);
      expect(result.has(expectedHash1)).toBe(true);
      expect(result.has(expectedHash2)).toBe(true);
    });

    it('uses 90-day window by default', async () => {
      vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

      await buildDuplicateHashSet('tenant-1', 1);

      const call = vi.mocked(prisma.transaction.findMany).mock.calls[0][0] as any;
      const dateFilter = call.where.transaction_date;

      // The gte date should be approximately 90 days ago
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const diffMs = Math.abs(dateFilter.gte.getTime() - ninetyDaysAgo.getTime());
      expect(diffMs).toBeLessThan(1000); // within 1 second
      expect(dateFilter.lte).toBeUndefined();
    });

    it('expands window when minDate is older than 90 days', async () => {
      vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

      const oldDate = new Date('2020-01-01');
      await buildDuplicateHashSet('tenant-1', 1, oldDate);

      const call = vi.mocked(prisma.transaction.findMany).mock.calls[0][0] as any;
      const dateFilter = call.where.transaction_date;

      // Should be minDate - 1 day (buffer)
      const expected = new Date('2019-12-31');
      expect(dateFilter.gte.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
    });

    it('sets date ceiling when maxDate is provided', async () => {
      vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

      const maxDate = new Date('2024-06-15');
      await buildDuplicateHashSet('tenant-1', 1, null, maxDate);

      const call = vi.mocked(prisma.transaction.findMany).mock.calls[0][0] as any;
      const dateFilter = call.where.transaction_date;

      // Should be maxDate + 1 day (buffer)
      const expected = new Date('2024-06-16');
      expect(dateFilter.lte.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
    });

    it('queries with correct tenantId and accountId', async () => {
      vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

      await buildDuplicateHashSet('tenant-abc', 42);

      const call = vi.mocked(prisma.transaction.findMany).mock.calls[0][0] as any;
      expect(call.where.tenantId).toBe('tenant-abc');
      expect(call.where.accountId).toBe(42);
    });

    it('uses credit when debit is null', async () => {
      const mockTxs = [
        { transaction_date: new Date('2024-01-15'), description: 'Salary', credit: 3000, debit: null, accountId: 1 },
      ];
      vi.mocked(prisma.transaction.findMany).mockResolvedValue(mockTxs as any);

      const result = await buildDuplicateHashSet('tenant-1', 1);

      const expectedHash = computeTransactionHash(new Date('2024-01-15'), 'Salary', 3000, 1);
      expect(result.has(expectedHash)).toBe(true);
    });
  });
});
