/**
 * Unit tests for insightGeneratorWorker.
 *
 * The worker processes two job types:
 * - generate-tenant-insights: single tenant (on-demand)
 * - generate-all-insights: iterates all tenants (daily cron)
 */

// ─── Mocks (must be declared before require) ────────────────────────────────

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('../../../queues/insightQueue', () => ({
  INSIGHT_QUEUE_NAME: 'test-insights',
  getInsightQueue: jest.fn().mockReturnValue({
    add: jest.fn().mockResolvedValue({}),
  }),
}));

let workerCallback;
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_queue, callback) => {
    workerCallback = callback;
    return { on: jest.fn(), close: jest.fn() };
  }),
}));

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn() })),
  captureException: jest.fn(),
}));

const mockGenerateInsights = jest.fn();
jest.mock('../../../services/insightService', () => ({
  generateInsights: (...args) => mockGenerateInsights(...args),
}));

const mockTenantFindMany = jest.fn();
jest.mock('../../../../prisma/prisma.js', () => ({
  tenant: {
    findMany: (...args) => mockTenantFindMany(...args),
  },
}));

// ─── Import (after mocks) ───────────────────────────────────────────────────

const Sentry = require('@sentry/node');
const { startInsightGeneratorWorker } = require('../../../workers/insightGeneratorWorker');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeJob(name, data = {}) {
  return { id: `test-job-${name}`, name, data };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('insightGeneratorWorker', () => {
  beforeAll(() => {
    startInsightGeneratorWorker();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generate-tenant-insights', () => {
    it('calls generateInsights for the given tenantId', async () => {
      const mockInsights = [{ lens: 'SPENDING_VELOCITY', title: 'Test' }];
      mockGenerateInsights.mockResolvedValue(mockInsights);

      const result = await workerCallback(makeJob('generate-tenant-insights', { tenantId: 'tenant-1' }));

      expect(mockGenerateInsights).toHaveBeenCalledWith('tenant-1');
      expect(result.success).toBe(true);
      expect(result.insightCount).toBe(1);
    });

    it('throws when tenantId is missing', async () => {
      await expect(
        workerCallback(makeJob('generate-tenant-insights', {}))
      ).rejects.toThrow('tenantId is required');
    });
  });

  describe('generate-all-insights', () => {
    it('iterates all tenants with transactions and generates insights', async () => {
      mockTenantFindMany.mockResolvedValue([
        { id: 'tenant-a' },
        { id: 'tenant-b' },
      ]);
      mockGenerateInsights
        .mockResolvedValueOnce([{ lens: 'SPENDING_VELOCITY' }, { lens: 'INCOME_STABILITY' }])
        .mockResolvedValueOnce([{ lens: 'SAVINGS_RATE' }]);

      const result = await workerCallback(makeJob('generate-all-insights', {}));

      expect(mockTenantFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { transactions: { some: {} } } })
      );
      expect(mockGenerateInsights).toHaveBeenCalledTimes(2);
      expect(result.totalTenants).toBe(2);
      expect(result.totalInsights).toBe(3);
      expect(result.errors).toBe(0);
    });

    it('continues processing when one tenant fails and reports to Sentry', async () => {
      mockTenantFindMany.mockResolvedValue([
        { id: 'tenant-ok' },
        { id: 'tenant-fail' },
        { id: 'tenant-ok2' },
      ]);
      mockGenerateInsights
        .mockResolvedValueOnce([{ lens: 'SPENDING_VELOCITY' }])
        .mockRejectedValueOnce(new Error('Gemini timeout'))
        .mockResolvedValueOnce([{ lens: 'DEBT_HEALTH' }]);

      const result = await workerCallback(makeJob('generate-all-insights', {}));

      expect(result.errors).toBe(1);
      expect(result.totalInsights).toBe(2);
      expect(Sentry.withScope).toHaveBeenCalled();
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it('handles zero tenants gracefully', async () => {
      mockTenantFindMany.mockResolvedValue([]);

      const result = await workerCallback(makeJob('generate-all-insights', {}));

      expect(mockGenerateInsights).not.toHaveBeenCalled();
      expect(result.totalTenants).toBe(0);
      expect(result.totalInsights).toBe(0);
    });
  });

  it('throws on unknown job name', async () => {
    await expect(
      workerCallback(makeJob('unknown-job', {}))
    ).rejects.toThrow('Unknown insight job name: unknown-job');
  });
});
