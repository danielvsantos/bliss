/**
 * Unit tests for insightGeneratorWorker (v1 — tiered architecture).
 *
 * Job types covered:
 *   - generate-tenant-insights (legacy, no tier → delegates to generateInsights)
 *   - generate-tenant-insights WITH tier → generateTieredInsights
 *   - generate-all-insights (daily cron → generateAllDueTiers per tenant)
 *   - generate-daily-pulse (DAILY-only per tenant via generateTieredInsights)
 *   - generate-portfolio-intel (weekly Monday cron over equity-holding tenants)
 *   - unknown job name → throws
 *
 * Also verifies:
 *   - tenants with transactions query shape for the daily cron
 *   - tenants with equity holdings query shape for the portfolio-intel cron
 *   - Per-tenant errors are reported via Sentry.withScope but do not stop the loop
 *   - worker.on('failed') wiring delegates to reportWorkerFailure
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

const mockQueueAdd = jest.fn().mockResolvedValue({});
jest.mock('../../../queues/insightQueue', () => ({
  INSIGHT_QUEUE_NAME: 'test-insights',
  getInsightQueue: jest.fn().mockReturnValue({
    add: mockQueueAdd,
  }),
}));

let workerCallback;
let workerOnHandlers = {};
const mockWorkerOn = jest.fn((event, cb) => { workerOnHandlers[event] = cb; });
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_queue, callback) => {
    workerCallback = callback;
    return { on: mockWorkerOn, close: jest.fn() };
  }),
}));

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn(), setContext: jest.fn() })),
  captureException: jest.fn(),
}));

const mockGenerateInsights = jest.fn();
const mockGenerateTieredInsights = jest.fn();
const mockGenerateAllDueTiers = jest.fn();
jest.mock('../../../services/insightService', () => ({
  generateInsights: (...args) => mockGenerateInsights(...args),
  generateTieredInsights: (...args) => mockGenerateTieredInsights(...args),
  generateAllDueTiers: (...args) => mockGenerateAllDueTiers(...args),
}));

const mockTenantFindMany = jest.fn();
jest.mock('../../../../prisma/prisma.js', () => ({
  tenant: {
    findMany: (...args) => mockTenantFindMany(...args),
  },
}));

const mockReportWorkerFailure = jest.fn();
jest.mock('../../../utils/workerFailureReporter', () => ({
  reportWorkerFailure: (...args) => mockReportWorkerFailure(...args),
}));

// ─── Import (after mocks) ───────────────────────────────────────────────────

const Sentry = require('@sentry/node');
const { startInsightGeneratorWorker } = require('../../../workers/insightGeneratorWorker');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeJob(name, data = {}) {
  return { id: `test-job-${name}`, name, data, attemptsMade: 0, opts: { attempts: 1 } };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// Snapshot the cron registrations BEFORE any `jest.clearAllMocks()` wipes them.
// `startInsightGeneratorWorker()` is invoked at module load via the describe's
// beforeAll; we capture the queue.add call list here so the startup assertions
// remain stable across the test lifecycle.
let startupQueueAddCalls;

describe('insightGeneratorWorker', () => {
  beforeAll(() => {
    startInsightGeneratorWorker();
    // Capture a snapshot so jest.clearAllMocks() in beforeEach doesn't wipe it.
    startupQueueAddCalls = mockQueueAdd.mock.calls.map((c) => [...c]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Startup wiring ───────────────────────────────────────────────────────
  describe('startup', () => {
    it('registers the daily cron (generate-all-insights at 06:00 UTC)', () => {
      const dailyCron = startupQueueAddCalls.find((c) => c[0] === 'generate-all-insights');
      expect(dailyCron).toBeDefined();
      expect(dailyCron[2].repeat.pattern).toBe('0 6 * * *');
      expect(dailyCron[2].jobId).toBe('daily-insight-generation');
    });

    it('registers the weekly portfolio-intel cron (Mondays 05:00 UTC)', () => {
      const weeklyCron = startupQueueAddCalls.find((c) => c[0] === 'generate-portfolio-intel');
      expect(weeklyCron).toBeDefined();
      expect(weeklyCron[2].repeat.pattern).toBe('0 5 * * 1');
      expect(weeklyCron[2].jobId).toBe('weekly-portfolio-intel');
    });

    it('wires worker.on("failed") to reportWorkerFailure', () => {
      expect(workerOnHandlers.failed).toBeDefined();

      const fakeJob = {
        id: 'j1',
        name: 'generate-tenant-insights',
        data: { tenantId: 't-1', tier: 'DAILY', periodKey: '2026-04-09' },
        attemptsMade: 1,
        opts: { attempts: 3 },
      };
      const fakeErr = new Error('boom');

      workerOnHandlers.failed(fakeJob, fakeErr);

      expect(mockReportWorkerFailure).toHaveBeenCalledWith(expect.objectContaining({
        workerName: 'insightGenerator',
        job: fakeJob,
        error: fakeErr,
        extra: expect.objectContaining({ tier: 'DAILY', periodKey: '2026-04-09' }),
      }));
    });
  });

  // ── generate-tenant-insights ─────────────────────────────────────────────
  describe('generate-tenant-insights', () => {
    it('legacy path (no tier): delegates to generateInsights and returns insightCount', async () => {
      mockGenerateInsights.mockResolvedValue({
        insights: [{ lens: 'SPENDING_VELOCITY', title: 'Test' }],
        batchId: 'b1',
        periodKey: '2026-04-09',
      });

      const result = await workerCallback(makeJob('generate-tenant-insights', { tenantId: 'tenant-1' }));

      expect(mockGenerateInsights).toHaveBeenCalledWith('tenant-1');
      expect(mockGenerateTieredInsights).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.insightCount).toBe(1);
    });

    it('tiered path: delegates to generateTieredInsights with options', async () => {
      mockGenerateTieredInsights.mockResolvedValue({
        insights: [{ lens: 'INCOME_STABILITY' }, { lens: 'SAVINGS_RATE' }],
        batchId: 'b1',
        periodKey: '2026-03',
      });

      const result = await workerCallback(
        makeJob('generate-tenant-insights', {
          tenantId: 'tenant-1',
          tier: 'MONTHLY',
          year: 2026,
          month: 3,
          periodKey: '2026-03',
          force: false,
        }),
      );

      expect(mockGenerateTieredInsights).toHaveBeenCalledWith(
        'tenant-1',
        'MONTHLY',
        expect.objectContaining({ year: 2026, month: 3, periodKey: '2026-03', force: false }),
      );
      expect(mockGenerateInsights).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.insights).toHaveLength(2);
      expect(result.periodKey).toBe('2026-03');
    });

    it('tiered path: returns skipped result without throwing when tier skipped', async () => {
      mockGenerateTieredInsights.mockResolvedValue({ skipped: true, reason: 'Data unchanged' });

      const result = await workerCallback(
        makeJob('generate-tenant-insights', { tenantId: 'tenant-1', tier: 'DAILY' }),
      );

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('Data unchanged');
    });

    it('throws when tenantId is missing', async () => {
      await expect(
        workerCallback(makeJob('generate-tenant-insights', {})),
      ).rejects.toThrow('tenantId is required');
    });
  });

  // ── generate-all-insights (daily cron) ───────────────────────────────────
  describe('generate-all-insights', () => {
    it('iterates tenants with transactions and calls generateAllDueTiers', async () => {
      mockTenantFindMany.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
      mockGenerateAllDueTiers
        .mockResolvedValueOnce({
          DAILY: { insights: [{ lens: 'SPENDING_VELOCITY' }] },
          MONTHLY: { insights: [{ lens: 'INCOME_STABILITY' }, { lens: 'SAVINGS_RATE' }] },
        })
        .mockResolvedValueOnce({
          DAILY: { insights: [{ lens: 'CATEGORY_CONCENTRATION' }] },
        });

      const result = await workerCallback(makeJob('generate-all-insights', {}));

      expect(mockTenantFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { transactions: { some: {} } } }),
      );
      expect(mockGenerateAllDueTiers).toHaveBeenCalledTimes(2);
      expect(mockGenerateAllDueTiers).toHaveBeenCalledWith('tenant-a');
      expect(mockGenerateAllDueTiers).toHaveBeenCalledWith('tenant-b');

      expect(result.totalTenants).toBe(2);
      expect(result.totalInsights).toBe(4); // 1 + 2 + 1
      expect(result.errors).toBe(0);

      // Per-tier aggregation
      expect(result.tierResults.DAILY).toEqual({ generated: 2, skipped: 0 });
      expect(result.tierResults.MONTHLY).toEqual({ generated: 1, skipped: 0 });
    });

    it('counts skipped tiers separately from generated', async () => {
      mockTenantFindMany.mockResolvedValue([{ id: 'tenant-a' }]);
      mockGenerateAllDueTiers.mockResolvedValueOnce({
        DAILY: { skipped: true, reason: 'Dedup' },
        MONTHLY: { insights: [{ lens: 'INCOME_STABILITY' }] },
      });

      const result = await workerCallback(makeJob('generate-all-insights', {}));

      expect(result.tierResults.DAILY).toEqual({ generated: 0, skipped: 1 });
      expect(result.tierResults.MONTHLY).toEqual({ generated: 1, skipped: 0 });
      expect(result.totalInsights).toBe(1);
    });

    it('continues processing when one tenant fails and reports inline to Sentry', async () => {
      mockTenantFindMany.mockResolvedValue([
        { id: 'tenant-ok' },
        { id: 'tenant-fail' },
        { id: 'tenant-ok2' },
      ]);
      mockGenerateAllDueTiers
        .mockResolvedValueOnce({ DAILY: { insights: [{ lens: 'SPENDING_VELOCITY' }] } })
        .mockRejectedValueOnce(new Error('Gemini timeout'))
        .mockResolvedValueOnce({ DAILY: { insights: [{ lens: 'DEBT_HEALTH' }] } });

      const result = await workerCallback(makeJob('generate-all-insights', {}));

      expect(result.errors).toBe(1);
      expect(result.totalInsights).toBe(2);
      // Inline catch uses Sentry.withScope + captureException (not reportWorkerFailure,
      // since this is per-record, not job-level)
      expect(Sentry.withScope).toHaveBeenCalled();
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it('handles zero tenants gracefully', async () => {
      mockTenantFindMany.mockResolvedValue([]);

      const result = await workerCallback(makeJob('generate-all-insights', {}));

      expect(mockGenerateAllDueTiers).not.toHaveBeenCalled();
      expect(result.totalTenants).toBe(0);
      expect(result.totalInsights).toBe(0);
    });
  });

  // ── generate-daily-pulse ─────────────────────────────────────────────────
  describe('generate-daily-pulse', () => {
    it('calls generateTieredInsights(DAILY) per tenant', async () => {
      mockTenantFindMany.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
      mockGenerateTieredInsights
        .mockResolvedValueOnce({ insights: [{ lens: 'SPENDING_VELOCITY' }] })
        .mockResolvedValueOnce({ insights: [{ lens: 'UNUSUAL_SPENDING' }] });

      const result = await workerCallback(makeJob('generate-daily-pulse', {}));

      expect(mockGenerateAllDueTiers).not.toHaveBeenCalled();
      expect(mockGenerateTieredInsights).toHaveBeenCalledTimes(2);
      expect(mockGenerateTieredInsights).toHaveBeenCalledWith('tenant-a', 'DAILY');
      expect(mockGenerateTieredInsights).toHaveBeenCalledWith('tenant-b', 'DAILY');
      expect(result.totalInsights).toBe(2);
    });

    it('counts skipped daily runs without incrementing totalInsights', async () => {
      mockTenantFindMany.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
      mockGenerateTieredInsights
        .mockResolvedValueOnce({ skipped: true, reason: 'Dedup' })
        .mockResolvedValueOnce({ insights: [{ lens: 'SPENDING_VELOCITY' }] });

      const result = await workerCallback(makeJob('generate-daily-pulse', {}));
      expect(result.totalInsights).toBe(1);
    });
  });

  // ── generate-portfolio-intel ─────────────────────────────────────────────
  describe('generate-portfolio-intel', () => {
    it('queries tenants with equity holdings and calls generateTieredInsights(PORTFOLIO)', async () => {
      mockTenantFindMany.mockResolvedValue([{ id: 'tenant-a' }]);
      mockGenerateTieredInsights.mockResolvedValue({
        insights: [{ lens: 'SECTOR_CONCENTRATION' }, { lens: 'VALUATION_RISK' }],
      });

      const result = await workerCallback(makeJob('generate-portfolio-intel', {}));

      // Verify the shape of the tenant query — must filter on equity portfolioItems
      expect(mockTenantFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            portfolioItems: expect.objectContaining({
              some: expect.objectContaining({
                quantity: { gt: 0 },
                ticker: { not: null },
              }),
            }),
          }),
        }),
      );

      expect(mockGenerateTieredInsights).toHaveBeenCalledWith('tenant-a', 'PORTFOLIO');
      expect(result.totalTenants).toBe(1);
      expect(result.totalInsights).toBe(2);
      expect(result.errors).toBe(0);
    });

    it('continues when a tenant fails; reports inline to Sentry', async () => {
      mockTenantFindMany.mockResolvedValue([
        { id: 'tenant-ok' },
        { id: 'tenant-fail' },
      ]);
      mockGenerateTieredInsights
        .mockResolvedValueOnce({ insights: [{ lens: 'SECTOR_CONCENTRATION' }] })
        .mockRejectedValueOnce(new Error('SecurityMaster down'));

      const result = await workerCallback(makeJob('generate-portfolio-intel', {}));

      expect(result.errors).toBe(1);
      expect(result.totalInsights).toBe(1);
      expect(Sentry.withScope).toHaveBeenCalled();
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it('handles zero equity-holding tenants', async () => {
      mockTenantFindMany.mockResolvedValue([]);

      const result = await workerCallback(makeJob('generate-portfolio-intel', {}));
      expect(mockGenerateTieredInsights).not.toHaveBeenCalled();
      expect(result.totalTenants).toBe(0);
      expect(result.totalInsights).toBe(0);
    });
  });

  // ── Unknown job name ─────────────────────────────────────────────────────
  it('throws on unknown job name', async () => {
    await expect(
      workerCallback(makeJob('unknown-job', {})),
    ).rejects.toThrow('Unknown insight job name: unknown-job');
  });
});
