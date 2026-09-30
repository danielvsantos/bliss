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
const { scheduleDebouncedJob, mergers } = require('../../../services/debounceService');

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

  it('unions portfolioItemIds across debounced events instead of keeping only the latest (#86)', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({
      jobId: 'old-job', tenantId: 't1', needsCashRebuild: [true], portfolioItemIds: [10, 11, 99],
    }));

    // The later event carries no portfolioItemIds (e.g. an edit's simple-transaction half).
    await scheduleDebouncedJob(mockQueue, 'process-cash-holdings', { tenantId: 't1', needsCashRebuild: [true] }, 'needsCashRebuild', 5);
    expect(mockQueue.add.mock.calls[0][1].portfolioItemIds).toEqual([10, 11, 99]);

    mockQueue.add.mockClear();
    await scheduleDebouncedJob(mockQueue, 'process-cash-holdings',
      { tenantId: 't1', needsCashRebuild: [true], portfolioItemIds: [11, 12] }, 'needsCashRebuild', 5);
    expect(mockQueue.add.mock.calls[0][1].portfolioItemIds).toEqual([10, 11, 99, 12]);
  });

  it('leaves portfolioItemIds absent when neither event carries them', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ jobId: 'old-job', tenantId: 't1', needsCashRebuild: [true] }));
    await scheduleDebouncedJob(mockQueue, 'process-cash-holdings', { tenantId: 't1', needsCashRebuild: [true] }, 'needsCashRebuild', 5);
    expect(mockQueue.add.mock.calls[0][1]).not.toHaveProperty('portfolioItemIds');
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

  // ── #92: every scope-bearing field is merged, not just the aggregation key ──

  describe('fieldMergers (#92)', () => {
    const CASH_MERGERS = {
      scope: mergers.cashScope,
      originalScope: mergers.analyticsScope,
      portfolioItemIds: mergers.union,
      _rebuildMeta: mergers.keepPresent,
    };

    const pending = (data) => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ jobId: 'old-job-id', ...data }));
      mockQueue.getJob.mockResolvedValue({ remove: jest.fn().mockResolvedValue(undefined) });
    };
    const scheduledData = () => mockQueue.add.mock.calls[0][1];

    it('two manual creates in different months/groups keep both analytics scopes', async () => {
      // July grocery, then August ETF buy within the debounce window.
      pending({
        tenantId: 't1',
        scope: { currency: 'EUR', year: 2026 },
        originalScope: { earliestDate: '2026-07-01', filters: { type: ['Essentials'], group: ['Groceries'], currency: ['EUR'], country: ['PT'] } },
        needsCashRebuild: [true],
      });

      await scheduleDebouncedJob(mockQueue, 'process-cash-holdings', {
        tenantId: 't1',
        scope: { currency: 'EUR', year: 2026 },
        originalScope: { earliestDate: '2026-08-01', filters: { type: ['Investments'], group: ['ETFs'], currency: ['EUR'], country: ['PT'] } },
        needsCashRebuild: [true],
      }, 'needsCashRebuild', 5, CASH_MERGERS);

      expect(scheduledData()).toEqual({
        tenantId: 't1',
        scope: { currency: 'EUR', year: 2026 },
        originalScope: {
          earliestDate: '2026-07-01',
          filters: { type: ['Essentials', 'Investments'], group: ['Groceries', 'ETFs'], currency: ['EUR'], country: ['PT'] },
        },
        needsCashRebuild: [true],
      });
      // The Redis record carries the merged data too, so a third event merges into it.
      const stored = JSON.parse(mockRedis.set.mock.calls[0][1]);
      expect(stored.originalScope.earliestDate).toBe('2026-07-01');
    });

    it('cash scope: different currencies widen to all currencies, earliest year wins', async () => {
      pending({ tenantId: 't1', scope: { currency: 'USD', year: 2025 }, needsCashRebuild: [true] });

      await scheduleDebouncedJob(mockQueue, 'process-cash-holdings', {
        tenantId: 't1', scope: { currency: 'EUR', year: 2026 }, needsCashRebuild: [true],
      }, 'needsCashRebuild', 5, CASH_MERGERS);

      expect(scheduledData().scope).toEqual({ year: 2025 });
    });

    it('cash scope: a pending full rebuild (no scope) is never narrowed by a later scoped event', async () => {
      pending({ tenantId: 't1', needsCashRebuild: [true], _rebuildMeta: { rebuildType: 'full-portfolio' } });

      await scheduleDebouncedJob(mockQueue, 'process-cash-holdings', {
        tenantId: 't1',
        scope: { currency: 'EUR', year: 2026 },
        originalScope: { earliestDate: '2026-08-01', filters: {} },
        needsCashRebuild: [true],
      }, 'needsCashRebuild', 5, CASH_MERGERS);

      const data = scheduledData();
      expect(data).not.toHaveProperty('scope');
      // The admin rebuild marker survives, so its lock is still released.
      expect(data._rebuildMeta).toEqual({ rebuildType: 'full-portfolio' });
    });

    it('originalScope: an absent side contributes nothing; an absent filter key means unfiltered', async () => {
      pending({ tenantId: 't1', scope: { year: 2026 }, portfolioItemIds: [1], needsCashRebuild: [true] });

      await scheduleDebouncedJob(mockQueue, 'process-cash-holdings', {
        tenantId: 't1',
        scope: { year: 2026 },
        originalScope: { earliestDate: '2026-03-01', filters: { type: ['Essentials'] } },
        portfolioItemIds: [2],
        needsCashRebuild: [true],
      }, 'needsCashRebuild', 5, CASH_MERGERS);

      expect(scheduledData().originalScope).toEqual({ earliestDate: '2026-03-01', filters: { type: ['Essentials'] } });
      expect(scheduledData().portfolioItemIds).toEqual([1, 2]);

      expect(mergers.analyticsScope(
        { earliestDate: '2026-03-01', filters: { type: ['Essentials'], group: ['Food'] } },
        { earliestDate: '2026-01-01', filters: { type: ['Lifestyle'] } },
      )).toEqual({ earliestDate: '2026-01-01', filters: { type: ['Essentials', 'Lifestyle'] } });
    });

    it('process-portfolio-changes: unions accountIds and dateScopes; no accountIds (full rebuild) wins', async () => {
      const PPC_MERGERS = { accountIds: mergers.unionOrAll, dateScopes: mergers.union };

      pending({ tenantId: 't1', needsSync: [true], accountIds: [1], dateScopes: [{ year: 2026, month: 7 }] });
      await scheduleDebouncedJob(mockQueue, 'process-portfolio-changes', {
        tenantId: 't1', needsSync: [true], accountIds: [2], dateScopes: [{ year: 2026, month: 8 }],
      }, 'needsSync', 10, PPC_MERGERS);
      expect(scheduledData()).toEqual({
        tenantId: 't1',
        needsSync: [true],
        accountIds: [1, 2],
        dateScopes: [{ year: 2026, month: 7 }, { year: 2026, month: 8 }],
      });

      jest.clearAllMocks();
      mockQueue.add.mockResolvedValue({ id: 'mock-job-id' });
      pending({ tenantId: 't1', needsSync: [true] }); // e.g. TENANT_CURRENCY_SETTINGS_UPDATED
      await scheduleDebouncedJob(mockQueue, 'process-portfolio-changes', {
        tenantId: 't1', needsSync: [true], accountIds: [2], dateScopes: [{ year: 2026, month: 8 }],
      }, 'needsSync', 10, PPC_MERGERS);
      expect(scheduledData()).not.toHaveProperty('accountIds');
    });

    it('fields without a merger keep the newest value (backwards compatible)', async () => {
      pending({ tenantId: 't1', scopes: ['a'], other: 'old' });

      await scheduleDebouncedJob(mockQueue, 'SYNC', { tenantId: 't1', scopes: ['b'], other: 'new' }, 'scopes', 5);

      expect(scheduledData()).toEqual({ tenantId: 't1', scopes: ['a', 'b'], other: 'new' });
    });

    it('aggregation-key union dedupes objects by content', async () => {
      pending({ tenantId: 't1', scopes: [{ year: 2026, month: 7 }] });

      await scheduleDebouncedJob(mockQueue, 'scoped-update-analytics', {
        tenantId: 't1', scopes: [{ year: 2026, month: 7 }, { year: 2026, month: 8 }],
      }, 'scopes', 5);

      expect(scheduledData().scopes).toEqual([{ year: 2026, month: 7 }, { year: 2026, month: 8 }]);
    });
  });
});
