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
const mockGetAllActiveSecuritySymbols = jest.fn();
const mockGetAllSecurityMasterSymbols = jest.fn();
const mockGetTenantSecuritySymbols = jest.fn();
const mockUpsertEtfComposition = jest.fn();
const mockMarkEtfCompositionAttempt = jest.fn();
jest.mock('../../../services/securityMasterService', () => ({
  getBySymbol: (...args) => mockGetBySymbol(...args),
  upsertFromProfile: (...args) => mockUpsertFromProfile(...args),
  upsertFundamentals: (...args) => mockUpsertFundamentals(...args),
  upsertEtfComposition: (...args) => mockUpsertEtfComposition(...args),
  markEtfCompositionAttempt: (...args) => mockMarkEtfCompositionAttempt(...args),
  getAllActiveSecuritySymbols: (...args) => mockGetAllActiveSecuritySymbols(...args),
  getTenantSecuritySymbols: (...args) => mockGetTenantSecuritySymbols(...args),
  getAllSecurityMasterSymbols: (...args) => mockGetAllSecurityMasterSymbols(...args),
  isEtfAssetType: (t) => typeof t === 'string' && t.toUpperCase() === 'ETF',
}));

const mockMaybeReleaseRebuildLock = jest.fn();
jest.mock('../../../utils/rebuildLock', () => ({
  maybeReleaseRebuildLock: (...args) => mockMaybeReleaseRebuildLock(...args),
}));

const mockGetSymbolProfile = jest.fn();
const mockGetEarnings = jest.fn();
const mockGetDividends = jest.fn();
const mockGetLatestPrice = jest.fn();
const mockGetEtfComposition = jest.fn();
jest.mock('../../../services/twelveDataService', () => ({
  getEtfComposition: (...args) => mockGetEtfComposition(...args),
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
  mockGetEtfComposition.mockResolvedValue(QQQ_COMPOSITION);
  mockUpsertEtfComposition.mockResolvedValue(undefined);
}

const QQQ_COMPOSITION = {
  sectors: [{ sector: 'Technology', weight: 0.5915 }, { sector: 'Communication Services', weight: 0.1 }],
  countries: [],
  assetAllocation: { stocks: 0.9995, cash: 0.0005, bonds: 0 },
  creditsUsed: 1,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('securityMasterWorker', () => {
  let onCompleted;
  beforeAll(() => {
    // The worker has a sleep(MIN_MS_PER_SYMBOL) delay per symbol.
    // Override global setTimeout to resolve immediately so tests don't hang.
    const _originalSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, _ms) => {
      if (typeof fn === 'function') fn();
      return 0;
    });
    const instance = startSecurityMasterWorker();
    onCompleted = instance.on.mock.calls.find(([evt]) => evt === 'completed')[1];
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
    it('skips /earnings for an ETF (known from the stored row) and still refreshes dividends', async () => {
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'VWCE', exchange: 'XETR' }]);
      mockGetBySymbol.mockResolvedValue({ assetType: 'ETF', lastProfileUpdate: new Date() });

      const result = await workerCallback(makeJob('refresh-all-fundamentals', {}));

      expect(mockGetEarnings).not.toHaveBeenCalled();
      expect(mockGetDividends).toHaveBeenCalledWith('VWCE', expect.any(Object));
      expect(mockUpsertFundamentals).toHaveBeenCalledWith('VWCE', expect.objectContaining({ earnings: null }));
      expect(result.refreshed).toBe(1);
    });

    it('skips /earnings when a fresh profile reports type ETF', async () => {
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'QQQ', exchange: null }]);
      mockGetSymbolProfile.mockResolvedValue({ name: 'Invesco QQQ', type: 'ETF' });

      await workerCallback(makeJob('refresh-all-fundamentals', {}));

      expect(mockGetEarnings).not.toHaveBeenCalled();
    });

    it('refreshes all active stock symbols', async () => {
      mockGetAllActiveSecuritySymbols.mockResolvedValue([
        { symbol: 'AAPL', exchange: 'XNAS' },
        { symbol: 'GOOGL', exchange: 'XNAS' },
      ]);

      const job = makeJob('refresh-all-fundamentals', {});
      const result = await workerCallback(job);

      expect(mockGetAllActiveSecuritySymbols).toHaveBeenCalled();
      expect(mockUpsertFundamentals).toHaveBeenCalledTimes(2);
      expect(result.totalSymbols).toBe(2);
      expect(result.refreshed).toBe(2);
      expect(job.updateProgress).toHaveBeenCalled();
    });

    it('continues with next symbol on API failure', async () => {
      mockGetAllActiveSecuritySymbols.mockResolvedValue([
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
      expect(result.fundamentalsErrors).toBe(1);
      expect(result.refreshed).toBe(2); // AAPL and MSFT succeed
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it('runs fundamentals even when profile upsert fails (isolated try/catch)', async () => {
      // Regression test: previously, a P6004 timeout on the profile upsert was
      // swallowed by the service — the worker saw no error and moved on. Now
      // the service throws, and the worker's isolated try/catch around the
      // profile block ensures fundamentals still run for the same symbol.
      mockGetAllActiveSecuritySymbols.mockResolvedValue([
        { symbol: 'RDDT', exchange: 'XNYS' },
      ]);

      // Profile upsert fails (simulating P6004 timeout)
      mockUpsertFromProfile.mockRejectedValueOnce(new Error('P6004: query timeout'));

      const result = await workerCallback(makeJob('refresh-all-fundamentals', {}));

      // Fundamentals still ran despite the profile failure
      expect(mockGetEarnings).toHaveBeenCalledWith('RDDT', expect.any(Object));
      expect(mockGetDividends).toHaveBeenCalledWith('RDDT', expect.any(Object));
      expect(mockUpsertFundamentals).toHaveBeenCalledWith('RDDT', expect.any(Object));

      // Counters correctly reflect: profile failed, fundamentals succeeded
      expect(result.profilesRefreshed).toBe(0);
      expect(result.refreshed).toBe(1);
      expect(result.profileErrors).toBe(1);
      expect(result.fundamentalsErrors).toBe(0);
      expect(result.errors).toBe(1); // legacy combined counter

      // Sentry captured the profile failure with phase tag
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('ETF composition (#79)', () => {
    const DAY = 86400000;

    it('fetches and stores the composition for an ETF with none yet', async () => {
      mockGetBySymbol.mockResolvedValue({ assetType: 'ETF', lastProfileUpdate: new Date(), lastCompositionUpdate: null });
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'QQQ', exchange: 'XNAS' }]);
      await workerCallback(makeJob('refresh-all-fundamentals'));
      expect(mockGetEtfComposition).toHaveBeenCalledWith('QQQ', { micCode: 'XNAS' });
      expect(mockUpsertEtfComposition).toHaveBeenCalledWith('QQQ', QQQ_COMPOSITION);
    });

    it('refetches when the stored composition is older than 7 days', async () => {
      mockGetBySymbol.mockResolvedValue({
        assetType: 'ETF', lastProfileUpdate: new Date(), lastCompositionUpdate: new Date(Date.now() - 8 * DAY),
      });
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'QQQ', exchange: null }]);
      await workerCallback(makeJob('refresh-all-fundamentals'));
      expect(mockGetEtfComposition).toHaveBeenCalledTimes(1);
    });

    it('skips a fresh composition', async () => {
      mockGetBySymbol.mockResolvedValue({
        assetType: 'ETF', lastProfileUpdate: new Date(), lastCompositionUpdate: new Date(Date.now() - 2 * DAY),
      });
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'QQQ', exchange: null }]);
      await workerCallback(makeJob('refresh-all-fundamentals'));
      expect(mockGetEtfComposition).not.toHaveBeenCalled();
    });

    it('never fetches composition for a stock', async () => {
      mockGetBySymbol.mockResolvedValue({ assetType: 'Common Stock', lastProfileUpdate: new Date() });
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'KO', exchange: null }]);
      await workerCallback(makeJob('refresh-all-fundamentals'));
      expect(mockGetEtfComposition).not.toHaveBeenCalled();
    });

    it('keeps the previous composition when the fetch fails, without failing the symbol', async () => {
      mockGetBySymbol.mockResolvedValue({ assetType: 'ETF', lastProfileUpdate: new Date(), lastCompositionUpdate: null });
      mockGetEtfComposition.mockResolvedValue(null);
      mockGetSymbolProfile.mockResolvedValue({ name: 'Invesco QQQ', type: 'ETF' });
      const result = await workerCallback(makeJob('refresh-single-symbol', { symbol: 'QQQ' }));
      expect(mockUpsertEtfComposition).not.toHaveBeenCalled();
      expect(result.composition).toBe(false);
      expect(result.success).toBe(true);
    });

    it('reads the stored row on a forced profile refresh to check staleness', async () => {
      mockGetSymbolProfile.mockResolvedValue({ name: 'Invesco QQQ', type: 'ETF', micCode: 'XNAS' });
      mockGetBySymbol.mockResolvedValue({ assetType: 'ETF', lastCompositionUpdate: new Date() });
      const result = await workerCallback(makeJob('refresh-single-symbol', { symbol: 'QQQ' }));
      expect(mockGetBySymbol).toHaveBeenCalledWith('QQQ');
      expect(mockGetEtfComposition).not.toHaveBeenCalled();
      expect(result.composition).toBe(false);
    });

    it('waits 7 days after Twelve Data refuses the request (e.g. HTTP 403 plan restriction)', async () => {
      mockGetBySymbol.mockResolvedValue({ assetType: 'ETF', lastProfileUpdate: new Date(), lastCompositionUpdate: null });
      mockGetEtfComposition.mockResolvedValue({ unavailable: true, status: 403, message: 'not on your plan' });
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'VOO', exchange: null }]);
      await workerCallback(makeJob('refresh-all-fundamentals'));
      expect(mockMarkEtfCompositionAttempt).toHaveBeenCalledWith('VOO');
      expect(mockUpsertEtfComposition).not.toHaveBeenCalled();
    });

    it('does not stamp the attempt on a transient failure', async () => {
      mockGetBySymbol.mockResolvedValue({ assetType: 'ETF', lastProfileUpdate: new Date(), lastCompositionUpdate: null });
      mockGetEtfComposition.mockResolvedValue(null);
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'VOO', exchange: null }]);
      await workerCallback(makeJob('refresh-all-fundamentals'));
      expect(mockMarkEtfCompositionAttempt).not.toHaveBeenCalled();
    });

    it('tells upsertFundamentals the symbol is an ETF', async () => {
      mockGetBySymbol.mockResolvedValue({ assetType: 'ETF', lastProfileUpdate: new Date(), lastCompositionUpdate: new Date() });
      mockGetAllActiveSecuritySymbols.mockResolvedValue([{ symbol: 'VGK', exchange: null }]);
      await workerCallback(makeJob('refresh-all-fundamentals'));
      expect(mockUpsertFundamentals).toHaveBeenCalledWith('VGK', expect.objectContaining({ earnings: null, isEtf: true }));
    });

    it('logs and swallows a storage error', async () => {
      mockGetBySymbol.mockResolvedValue({ assetType: 'ETF', lastProfileUpdate: new Date(), lastCompositionUpdate: null });
      mockUpsertEtfComposition.mockRejectedValue(new Error('db down'));
      mockGetSymbolProfile.mockResolvedValue({ name: 'Invesco QQQ', type: 'ETF' });
      const result = await workerCallback(makeJob('refresh-single-symbol', { symbol: 'QQQ' }));
      expect(result.composition).toBe(false);
      expect(result.success).toBe(true);
    });
  });

  describe('refresh-tenant-securities', () => {
    it('refreshes only the symbols the service selects (missing or stale by default)', async () => {
      mockGetTenantSecuritySymbols.mockResolvedValue([{ symbol: 'KO', exchange: 'XNYS' }]);

      const result = await workerCallback(makeJob('refresh-tenant-securities', { tenantId: 't1' }));

      expect(mockGetTenantSecuritySymbols).toHaveBeenCalledWith('t1', { force: false });
      expect(mockUpsertFundamentals).toHaveBeenCalledTimes(1);
      expect(result).toEqual(expect.objectContaining({ success: true, tenantId: 't1', totalSymbols: 1, refreshed: 1 }));
    });

    it('passes force through (Maintenance "Refresh my securities data")', async () => {
      mockGetTenantSecuritySymbols.mockResolvedValue([]);
      const result = await workerCallback(makeJob('refresh-tenant-securities', { tenantId: 't1', force: true }));
      expect(mockGetTenantSecuritySymbols).toHaveBeenCalledWith('t1', { force: true });
      expect(result.totalSymbols).toBe(0);
    });

    it('throws without tenantId', async () => {
      await expect(workerCallback(makeJob('refresh-tenant-securities', {}))).rejects.toThrow('tenantId is required');
    });

    it('releases the security-data rebuild lock from the completed handler', async () => {
      const job = makeJob('refresh-tenant-securities', { tenantId: 't1', _rebuildMeta: { rebuildType: 'security-data' } });
      await onCompleted(job);
      expect(mockMaybeReleaseRebuildLock).toHaveBeenCalledWith(job);
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
