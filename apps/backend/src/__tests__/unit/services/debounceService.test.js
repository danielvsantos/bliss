/**
 * Unit tests for debounceService.scheduleDebouncedJob()
 *
 * Tests the Redis-backed debounce logic that aggregates high-frequency events
 * into a single delayed BullMQ job. Redis and BullMQ queue are mocked entirely.
 */

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid'),
}));

const { getRedisConnection } = require('../../../utils/redis');
const logger = require('../../../utils/logger');
const { scheduleDebouncedJob } = require('../../../services/debounceService');

// ── Mock objects ─────────────────────────────────────────────────────────────

const mockRedis = { get: jest.fn(), set: jest.fn() };
const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
  getJob: jest.fn(),
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('debounceService — scheduleDebouncedJob()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getRedisConnection.mockReturnValue(mockRedis);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    mockQueue.add.mockResolvedValue({ id: 'mock-job-id' });
    mockQueue.getJob.mockResolvedValue(null);
  });

  it('skips when tenantId is missing and logs a warning', async () => {
    await scheduleDebouncedJob(
      mockQueue,
      'SYNC_TRANSACTIONS',
      { scopes: ['scope1'] }, // no tenantId
      'scopes',
      10
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('without a tenantId')
    );
    expect(mockQueue.add).not.toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('creates a new delayed job when no existing Redis key exists', async () => {
    mockRedis.get.mockResolvedValue(null);

    await scheduleDebouncedJob(
      mockQueue,
      'SYNC_TRANSACTIONS',
      { tenantId: 'tenant-1', scopes: ['investments'] },
      'scopes',
      30
    );

    // Should schedule a new job with delay
    expect(mockQueue.add).toHaveBeenCalledWith(
      'SYNC_TRANSACTIONS',
      { tenantId: 'tenant-1', scopes: ['investments'] },
      { delay: 30000, jobId: 'mock-uuid' }
    );

    // Should store job details in Redis
    expect(mockRedis.set).toHaveBeenCalledWith(
      'debounce:SYNC_TRANSACTIONS:tenant:tenant-1',
      expect.any(String),
      'EX',
      35 // delay + 5 seconds buffer
    );

    // Verify the stored JSON contains the job data
    const storedJson = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(storedJson.jobId).toBe('mock-job-id');
    expect(storedJson.tenantId).toBe('tenant-1');
    expect(storedJson.scopes).toEqual(['investments']);
  });

  it('removes old job and creates new one with aggregated data', async () => {
    const existingJob = {
      jobId: 'old-job-id',
      tenantId: 'tenant-1',
      scopes: ['transactions'],
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(existingJob));

    const mockOldJob = { remove: jest.fn().mockResolvedValue(undefined) };
    mockQueue.getJob.mockResolvedValue(mockOldJob);

    await scheduleDebouncedJob(
      mockQueue,
      'SYNC_TRANSACTIONS',
      { tenantId: 'tenant-1', scopes: ['investments'] },
      'scopes',
      30
    );

    // Should have retrieved and removed the old job
    expect(mockQueue.getJob).toHaveBeenCalledWith('old-job-id');
    expect(mockOldJob.remove).toHaveBeenCalled();

    // Should schedule new job with aggregated scopes
    expect(mockQueue.add).toHaveBeenCalledWith(
      'SYNC_TRANSACTIONS',
      { tenantId: 'tenant-1', scopes: ['transactions', 'investments'] },
      { delay: 30000, jobId: 'mock-uuid' }
    );
  });

  it('deduplicates aggregated items using Set logic', async () => {
    const existingJob = {
      jobId: 'old-job-id',
      tenantId: 'tenant-1',
      scopes: ['investments', 'transactions'],
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(existingJob));

    const mockOldJob = { remove: jest.fn().mockResolvedValue(undefined) };
    mockQueue.getJob.mockResolvedValue(mockOldJob);

    await scheduleDebouncedJob(
      mockQueue,
      'SYNC_TRANSACTIONS',
      { tenantId: 'tenant-1', scopes: ['investments', 'balances'] },
      'scopes',
      30
    );

    // 'investments' appears in both existing and new — should be deduped
    const addCall = mockQueue.add.mock.calls[0];
    const jobData = addCall[1];
    expect(jobData.scopes).toEqual(['investments', 'transactions', 'balances']);
  });

  it('sets Redis key with TTL = delay + 5 seconds buffer', async () => {
    await scheduleDebouncedJob(
      mockQueue,
      'SYNC_TRANSACTIONS',
      { tenantId: 'tenant-1', scopes: ['investments'] },
      'scopes',
      60
    );

    expect(mockRedis.set).toHaveBeenCalledWith(
      'debounce:SYNC_TRANSACTIONS:tenant:tenant-1',
      expect.any(String),
      'EX',
      65 // 60 + 5
    );
  });

  it('handles Redis error gracefully without throwing', async () => {
    mockRedis.get.mockRejectedValue(new Error('Redis connection lost'));

    await expect(
      scheduleDebouncedJob(
        mockQueue,
        'SYNC_TRANSACTIONS',
        { tenantId: 'tenant-1', scopes: ['investments'] },
        'scopes',
        30
      )
    ).resolves.not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error in scheduleDebouncedJob'),
      expect.objectContaining({
        tenantId: 'tenant-1',
        error: 'Redis connection lost',
      })
    );
  });
});
