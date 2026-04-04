/**
 * Unit tests for securityMasterWorker.
 *
 * Job types:
 * - refresh-single-symbol: on-demand single symbol refresh
 * - refresh-all-fundamentals: nightly batch of all active stock symbols
 * - refresh-all-from-table: refresh all symbols in SecurityMaster table
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('../../../queues/securityMasterQueue', () => ({
  SECURITY_MASTER_QUEUE_NAME: 'test-security-master',
  getSecurityMasterQueue: jest.fn().mockReturnValue({
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

const mockGetBySymbol = jest.fn();
const mockUpsertFromProfile = jest.fn();
const mockUpsertFundamentals = jest.fn();
const mockGetAllActiveStockSymbols = jest.fn();
const mockGetAllSecurityMasterSymbols = jest.fn();
jest.mock('../../../services/securityMasterService', () => ({
  getBySymbol: (...args) => mockGetBySymbol(...args),
  upsertFromProfile: (...args) => mockUpsertFromProfile(...args),
  upsertFundamentals: (...args) => mockUpsertFundamentals(...args),
  getAllActiveStockSymbols: (...args) => mockGetAllActiveStockSymbols(...args),
  getAllSecurityMasterSymbols: (...args) => mockGetAllSecurityMasterSymbols(...args),
}));

const mockGetSymbolProfile = jest.fn();
const mockGetEarnings = jest.fn();
const mockGetDividends = jest.fn();
const mockGetLatestPrice = jest.fn();
jest.mock('../../../services/twelveDataService', () => ({
  getSymbolProfile: (...args) => mockGetSymbolProfile(...args),
  getEarnings: (...args) => mockGetEarnings(...args),
  getDividends: (...args) => mockGetDividends(...args),
  getLatestPrice: (...args) => mockGetLatestPrice(...args),
}));

jest.mock('../../../../prisma/prisma.js', () => ({
  portfolioItem: {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
}));

// ─── Import ─────────────────────────────────────────────────────────────────

const Sentry = require('@sentry/node');
const { startSecurityMasterWorker } = require('../../../workers/securityMasterWorker');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeJob(name, data = {}) {
  return { id: `test-job-${name}`, name, data, updateProgress: jest.fn() };
}

function setupSuccessfulApis() {
  mockGetBySymbol.mockResolvedValue(null); // profile is stale
  mockGetSymbolProfile.mockResolvedValue({ name: 'Apple Inc', micCode: 'XNAS' });
  mockUpsertFromProfile.mockResolvedValue(undefined);
  mockGetLatestPrice.mockResolvedValue({ close: 150.0 });
  mockGetEarnings.mockResolvedValue({ eps: 6.5 });
  mockGetDividends.mockResolvedValue({ amount: 0.82 });
  mockUpsertFundamentals.mockResolvedValue(undefined);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('securityMasterWorker', () => {
  beforeAll(() => {
    // The worker has a sleep(MIN_MS_PER_SYMBOL) delay per symbol.
    // Override global setTimeout to resolve immediately so tests don't hang.
    const originalSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, _ms) => {
      if (typeof fn === 'function') fn();
      return 0;
    });
    startSecurityMasterWorker();
  });

  afterAll(() => {
    global.setTimeout.mockRestore?.();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setupSuccessfulApis();
  });

  describe('refresh-single-symbol', () => {
    it('refreshes profile and fundamentals for a single symbol', async () => {
      const result = await workerCallback(makeJob('refresh-single-symbol', { symbol: 'AAPL' }));

      expect(mockGetSymbolProfile).toHaveBeenCalledWith('AAPL', expect.any(Object));
      expect(mockGetLatestPrice).toHaveBeenCalledWith('AAPL', expect.any(Object));
      expect(mockGetEarnings).toHaveBeenCalledWith('AAPL', expect.any(Object));
      expect(mockGetDividends).toHaveBeenCalledWith('AAPL', expect.any(Object));
      expect(mockUpsertFundamentals).toHaveBeenCalledWith('AAPL', expect.objectContaining({
        earnings: { eps: 6.5 },
        dividends: { amount: 0.82 },
        quote: { close: 150.0 },
      }));
      expect(result.success).toBe(true);
      expect(result.profile).toBe(true);
      expect(result.fundamentals).toBe(true);
    });

    it('throws when symbol is missing', async () => {
      await expect(
        workerCallback(makeJob('refresh-single-symbol', {}))
      ).rejects.toThrow('symbol is required');
    });

    it('passes exchange as micCode when it looks like a valid MIC code', async () => {
      await workerCallback(makeJob('refresh-single-symbol', { symbol: 'PETR4', exchange: 'BVMF' }));

      expect(mockGetSymbolProfile).toHaveBeenCalledWith('PETR4', expect.objectContaining({ micCode: 'BVMF' }));
    });

    it('skips invalid mic_code display names like NYSE', async () => {
      await workerCallback(makeJob('refresh-single-symbol', { symbol: 'AAPL', exchange: 'NYSE' }));

      // Should NOT pass micCode since NYSE is a display name
      expect(mockGetSymbolProfile).toHaveBeenCalledWith('AAPL', expect.not.objectContaining({ micCode: 'NYSE' }));
    });
  });

  describe('refresh-all-fundamentals', () => {
    it('refreshes all active stock symbols', async () => {
      mockGetAllActiveStockSymbols.mockResolvedValue([
        { symbol: 'AAPL', exchange: 'XNAS' },
        { symbol: 'GOOGL', exchange: 'XNAS' },
      ]);

      const job = makeJob('refresh-all-fundamentals', {});
      const result = await workerCallback(job);

      expect(mockGetAllActiveStockSymbols).toHaveBeenCalled();
      expect(mockUpsertFundamentals).toHaveBeenCalledTimes(2);
      expect(result.totalSymbols).toBe(2);
      expect(result.refreshed).toBe(2);
      expect(job.updateProgress).toHaveBeenCalled();
    });

    it('continues with next symbol on API failure', async () => {
      mockGetAllActiveStockSymbols.mockResolvedValue([
        { symbol: 'AAPL', exchange: null },
        { symbol: 'FAIL', exchange: null },
        { symbol: 'MSFT', exchange: null },
      ]);

      // Make the second symbol fail at the earnings step
      mockGetEarnings
        .mockResolvedValueOnce({ eps: 6.5 })
        .mockRejectedValueOnce(new Error('API rate limit'))
        .mockResolvedValueOnce({ eps: 10.0 });

      const result = await workerCallback(makeJob('refresh-all-fundamentals', {}));

      expect(result.errors).toBe(1);
      expect(result.refreshed).toBe(2); // AAPL and MSFT succeed
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('refresh-all-from-table', () => {
    it('refreshes all symbols from SecurityMaster table', async () => {
      mockGetAllSecurityMasterSymbols.mockResolvedValue([
        { symbol: 'TSLA', exchange: 'XNAS' },
      ]);

      const result = await workerCallback(makeJob('refresh-all-from-table', {}));

      expect(mockGetAllSecurityMasterSymbols).toHaveBeenCalled();
      expect(result.totalSymbols).toBe(1);
      expect(result.refreshed).toBe(1);
    });
  });

  it('throws on unknown job name', async () => {
    await expect(
      workerCallback(makeJob('unknown-job', {}))
    ).rejects.toThrow('Unknown SecurityMaster job name: unknown-job');
  });
});
