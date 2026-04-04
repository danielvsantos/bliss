// Mock all dependencies before requiring the worker
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setExtra: jest.fn() })),
  init: jest.fn(),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('../../../queues/portfolioQueue', () => ({
  PORTFOLIO_QUEUE_NAME: 'test-portfolio',
  getPortfolioQueue: jest.fn().mockReturnValue({
    add: jest.fn().mockResolvedValue({ id: 'q-1' }),
  }),
}));

jest.mock('../../../../prisma/prisma', () => ({
  portfolioItem: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  tenant: {
    findMany: jest.fn(),
  },
}));

jest.mock('../../../workers/portfolio-handlers/process-portfolio-changes', () =>
  jest.fn().mockResolvedValue({ success: true })
);

jest.mock('../../../workers/portfolio-handlers/simple-liability-processor', () =>
  jest.fn().mockResolvedValue({ success: true })
);

jest.mock('../../../workers/portfolio-handlers/amortizing-loan-processor', () =>
  jest.fn().mockResolvedValue({ success: true })
);

jest.mock('../../../workers/portfolio-handlers/valuation/index.js', () =>
  jest.fn().mockResolvedValue({ success: true, snapshotsCreated: 5 })
);

jest.mock('../../../workers/portfolio-handlers/cash-processor', () => ({
  processCashHoldings: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../../workers/portfolio-handlers/recalculate-portfolio-item', () =>
  jest.fn().mockResolvedValue({ success: true })
);

const prisma = require('../../../../prisma/prisma');
const logger = require('../../../utils/logger');
const Sentry = require('@sentry/node');
const processPortfolioChanges = require('../../../workers/portfolio-handlers/process-portfolio-changes');
const { processCashHoldings } = require('../../../workers/portfolio-handlers/cash-processor');
const generatePortfolioValuation = require('../../../workers/portfolio-handlers/valuation/index.js');
const simpleLiabilityProcessor = require('../../../workers/portfolio-handlers/simple-liability-processor');
const processAmortizingLoan = require('../../../workers/portfolio-handlers/amortizing-loan-processor');
const { getPortfolioQueue } = require('../../../queues/portfolioQueue');

// The processPortfolioJob is not exported, but startPortfolioWorker creates a Worker
// with it as the processor. We need to get at the processor function.
// Since the Worker constructor is mocked, we can grab the processor from the mock call.
const { startPortfolioWorker } = require('../../../workers/portfolioWorker');

// Extract the processPortfolioJob function from the Worker constructor mock
let processPortfolioJob;

describe('portfolioWorker — processPortfolioJob', () => {
  beforeAll(() => {
    // Start the worker to trigger the Worker constructor mock, then extract the processor
    startPortfolioWorker();
    const { Worker } = require('bullmq');
    const constructorCall = Worker.mock.calls[0];
    processPortfolioJob = constructorCall[1]; // second arg is the processor function
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeJob(name, data = {}) {
    return { id: `test-job-${name}`, name, data: { tenantId: 'tenant-1', ...data } };
  }

  it('routes process-portfolio-changes jobs to handler', async () => {
    const job = makeJob('process-portfolio-changes', { tenantId: 'tenant-1' });
    await processPortfolioJob(job);

    expect(processPortfolioChanges).toHaveBeenCalledWith(job);
  });

  it('routes process-cash-holdings jobs to cash processor with enriched scope', async () => {
    const job = makeJob('process-cash-holdings', {
      tenantId: 'tenant-1',
      scope: { currency: 'USD' },
      originalScope: { year: 2026, month: 3 },
      portfolioItemIds: [1, 2],
    });
    await processPortfolioJob(job);

    expect(processCashHoldings).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        currency: 'USD',
        originalScope: { year: 2026, month: 3 },
        portfolioItemIds: [1, 2],
      })
    );
  });

  it('routes value-all-assets to valuation handler after fetching assets', async () => {
    const mockAssets = [
      { id: 1, symbol: 'AAPL', category: { type: 'Investments' } },
    ];
    prisma.portfolioItem.findMany.mockResolvedValue(mockAssets);

    const job = makeJob('value-all-assets', { tenantId: 'tenant-1' });
    await processPortfolioJob(job);

    expect(prisma.portfolioItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          category: { type: { in: ['Investments', 'Asset'] } },
        }),
      })
    );
    expect(generatePortfolioValuation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-1', assets: mockAssets }),
      })
    );
  });

  it('routes revalue-all-tenants to enqueue per-tenant jobs', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'tenant-1' },
      { id: 'tenant-2' },
    ]);

    const mockQueue = { add: jest.fn().mockResolvedValue({ id: 'q-1' }) };
    getPortfolioQueue.mockReturnValue(mockQueue);

    const job = makeJob('revalue-all-tenants', {});
    const result = await processPortfolioJob(job);

    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { portfolioItems: { some: {} } },
      })
    );

    // Each tenant gets 3 jobs: value-all-assets, process-simple-liability, process-amortizing-loan
    expect(mockQueue.add).toHaveBeenCalledTimes(6); // 2 tenants * 3 jobs
    expect(result.enqueued).toBe(2);
  });

  it('handles unknown job types gracefully', async () => {
    const job = makeJob('unknown-job-type', { tenantId: 'tenant-1' });
    await processPortfolioJob(job);

    expect(logger.warn).toHaveBeenCalledWith('Unknown portfolio job name: unknown-job-type');
  });

  it('skips value-all-assets when no investment assets exist', async () => {
    prisma.portfolioItem.findMany.mockResolvedValue([]);

    const job = makeJob('value-all-assets', { tenantId: 'tenant-1' });
    const result = await processPortfolioJob(job);

    expect(result).toEqual({ success: true, processed: 0 });
    expect(generatePortfolioValuation).not.toHaveBeenCalled();
  });

  it('routes process-simple-liability to liability processor', async () => {
    const mockDebts = [{ id: 1, symbol: 'Loan', category: { processingHint: 'SIMPLE_LIABILITY' } }];
    prisma.portfolioItem.findMany.mockResolvedValue(mockDebts);

    const job = makeJob('process-simple-liability', { tenantId: 'tenant-1' });
    await processPortfolioJob(job);

    expect(simpleLiabilityProcessor).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-1', debts: mockDebts }),
      })
    );
  });

  it('routes process-amortizing-loan to amortizing loan processor', async () => {
    const mockDebts = [{ id: 2, symbol: 'Mortgage', category: { processingHint: 'AMORTIZING_LOAN' } }];
    prisma.portfolioItem.findMany.mockResolvedValue(mockDebts);

    const job = makeJob('process-amortizing-loan', { tenantId: 'tenant-1' });
    await processPortfolioJob(job);

    expect(processAmortizingLoan).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-1', debts: mockDebts }),
      })
    );
  });

  it('throws errors up for BullMQ retry handling', async () => {
    processPortfolioChanges.mockRejectedValueOnce(new Error('DB failed'));

    const job = makeJob('process-portfolio-changes', { tenantId: 'tenant-1' });
    await expect(processPortfolioJob(job)).rejects.toThrow('DB failed');
  });
});
