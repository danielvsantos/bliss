// Mock all dependencies before requiring the worker
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('../../../queues/smartImportQueue', () => ({
  SMART_IMPORT_QUEUE_NAME: 'test-smart-import',
}));

jest.mock('../../../services/adapterEngine', () => ({
  parseFile: jest.fn(),
}));

jest.mock('../../../services/categorizationService', () => ({
  classify: jest.fn(),
}));

jest.mock('../../../utils/descriptionCache', () => ({
  warmDescriptionCache: jest.fn(),
}));

jest.mock('../../../utils/categoryCache', () => ({
  getCategoriesForTenant: jest.fn(),
}));

jest.mock('../../../../prisma/prisma', () => ({}));

jest.mock('@bliss/shared/storage', () => ({
  createStorageAdapter: jest.fn().mockReturnValue({
    uploadFile: jest.fn(),
    downloadFile: jest.fn(),
    deleteFile: jest.fn(),
  }),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('@sentry/node', () => ({
  withScope: jest.fn(),
  captureException: jest.fn(),
}));

const { computeTransactionHash } = require('../../../workers/smartImportWorker');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeTransactionHash()', () => {
  it('produces consistent SHA-256 for same inputs', () => {
    const hash1 = computeTransactionHash(new Date('2026-03-01'), 'Coffee Shop', 5.50, 1);
    const hash2 = computeTransactionHash(new Date('2026-03-01'), 'Coffee Shop', 5.50, 1);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('produces different hash for different description', () => {
    const hash1 = computeTransactionHash(new Date('2026-03-01'), 'Coffee Shop', 5.50, 1);
    const hash2 = computeTransactionHash(new Date('2026-03-01'), 'Tea House', 5.50, 1);
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash for different amount', () => {
    const hash1 = computeTransactionHash(new Date('2026-03-01'), 'Coffee Shop', 5.50, 1);
    const hash2 = computeTransactionHash(new Date('2026-03-01'), 'Coffee Shop', 10.00, 1);
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash for different date', () => {
    const hash1 = computeTransactionHash(new Date('2026-03-01'), 'Coffee Shop', 5.50, 1);
    const hash2 = computeTransactionHash(new Date('2026-03-02'), 'Coffee Shop', 5.50, 1);
    expect(hash1).not.toBe(hash2);
  });

  it('normalizes description to lowercase trimmed', () => {
    const hash1 = computeTransactionHash(new Date('2026-03-01'), '  Coffee Shop  ', 5.50, 1);
    const hash2 = computeTransactionHash(new Date('2026-03-01'), 'coffee shop', 5.50, 1);
    expect(hash1).toBe(hash2);
  });

  it('handles Date objects and ISO strings consistently', () => {
    const hash1 = computeTransactionHash(new Date('2026-03-01T00:00:00.000Z'), 'Test', 100, 1);
    const hash2 = computeTransactionHash('2026-03-01T00:00:00.000Z', 'Test', 100, 1);
    expect(hash1).toBe(hash2);
  });
});
