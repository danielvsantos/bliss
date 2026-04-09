// ─── securityMasterService.test.js ──────────────────────────────────────────
// Unit tests for SecurityMaster service: getBySymbol, getBySymbols,
// upsertFromProfile, upsertFundamentals, getAllActiveStockSymbols,
// getAllSecurityMasterSymbols.

jest.mock('../../../../prisma/prisma.js', () => ({
  securityMaster: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
  },
  portfolioItem: {
    findMany: jest.fn(),
  },
}));
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../../../prisma/prisma.js');
const {
  getBySymbol,
  getBySymbols,
  upsertFromProfile,
  upsertFundamentals,
  getAllActiveStockSymbols,
  getAllSecurityMasterSymbols,
} = require('../../../services/securityMasterService');

describe('securityMasterService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── getBySymbol ────────────────────────────────────────────────────────────
  describe('getBySymbol', () => {
    it('calls findUnique with correct where clause', async () => {
      const mockRecord = { symbol: 'AAPL', name: 'Apple Inc.' };
      prisma.securityMaster.findUnique.mockResolvedValue(mockRecord);

      const result = await getBySymbol('AAPL');

      expect(prisma.securityMaster.findUnique).toHaveBeenCalledWith({
        where: { symbol: 'AAPL' },
      });
      expect(result).toEqual(mockRecord);
    });

    it('returns null when symbol not found', async () => {
      prisma.securityMaster.findUnique.mockResolvedValue(null);

      const result = await getBySymbol('UNKNOWN');

      expect(result).toBeNull();
    });
  });

  // ─── getBySymbols ──────────────────────────────────────────────────────────
  describe('getBySymbols', () => {
    it('calls findMany with in filter', async () => {
      const mockRecords = [
        { symbol: 'AAPL', name: 'Apple Inc.' },
        { symbol: 'MSFT', name: 'Microsoft Corp.' },
      ];
      prisma.securityMaster.findMany.mockResolvedValue(mockRecords);

      const result = await getBySymbols(['AAPL', 'MSFT']);

      expect(prisma.securityMaster.findMany).toHaveBeenCalledWith({
        where: { symbol: { in: ['AAPL', 'MSFT'] } },
      });
      expect(result).toEqual(mockRecords);
    });

    it('returns empty array for empty input', async () => {
      const result = await getBySymbols([]);

      expect(prisma.securityMaster.findMany).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  // ─── upsertFromProfile ────────────────────────────────────────────────────
  describe('upsertFromProfile', () => {
    it('upserts profile data with knownMicCode as exchange', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      await upsertFromProfile('AAPL', {
        name: 'Apple Inc.',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        country: 'US',
        knownMicCode: 'XNAS',
        currency: 'USD',
        type: 'Common Stock',
      });

      expect(prisma.securityMaster.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { symbol: 'AAPL' },
          create: expect.objectContaining({
            symbol: 'AAPL',
            name: 'Apple Inc.',
            exchange: 'XNAS',
            sector: 'Technology',
          }),
          update: expect.objectContaining({
            name: 'Apple Inc.',
            exchange: 'XNAS',
          }),
        })
      );
    });

    it('falls back to micCode when knownMicCode is absent', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      await upsertFromProfile('MSFT', {
        name: 'Microsoft',
        micCode: 'XNAS',
      });

      expect(prisma.securityMaster.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ exchange: 'XNAS' }),
        })
      );
    });

    it('looks up existing exchange when no MIC code in profile', async () => {
      prisma.securityMaster.findUnique.mockResolvedValue({ exchange: 'XNYS' });
      prisma.securityMaster.upsert.mockResolvedValue({});

      await upsertFromProfile('IBM', { name: 'IBM', exchange: 'NYSE' });

      expect(prisma.securityMaster.findUnique).toHaveBeenCalledWith({
        where: { symbol: 'IBM' },
        select: { exchange: true },
      });
      // Should use existing exchange from DB, not the display name
      expect(prisma.securityMaster.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ exchange: 'XNYS' }),
        })
      );
    });

    it('propagates prisma errors to the caller (no silent swallow)', async () => {
      // Regression test: a previous version caught and logged the error, causing
      // silent failures where the worker's result.profile stayed true even though
      // no row was written. The caller is now responsible for isolating profile
      // failures, so the service MUST throw on upsert failure.
      prisma.securityMaster.upsert.mockRejectedValue(new Error('P6004: query timeout'));

      await expect(
        upsertFromProfile('AAPL', { name: 'Apple Inc.', knownMicCode: 'XNAS' })
      ).rejects.toThrow('P6004: query timeout');
    });
  });

  // ─── upsertFundamentals ───────────────────────────────────────────────────
  describe('upsertFundamentals', () => {
    const today = new Date().toISOString().split('T')[0];

    it('computes trailingEps correctly from last 4 quarters', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: today, epsActual: 1.50, surprisePrc: 2.1 },
          { date: '2025-12-01', epsActual: 1.40, surprisePrc: 1.5 },
          { date: '2025-09-01', epsActual: 1.30, surprisePrc: 0.8 },
          { date: '2025-06-01', epsActual: 1.20, surprisePrc: -0.5 },
          { date: '2025-03-01', epsActual: 1.10, surprisePrc: 0.3 }, // 5th quarter, excluded from trailing
        ],
      };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote: null });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      // trailingEps = 1.50 + 1.40 + 1.30 + 1.20 = 5.40
      expect(parseFloat(upsertCall.update.trailingEps)).toBeCloseTo(5.40, 2);
    });

    it('computes peRatio as latestPrice / trailingEps', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: today, epsActual: 2.00, surprisePrc: null },
          { date: '2025-12-01', epsActual: 2.00, surprisePrc: null },
          { date: '2025-09-01', epsActual: 2.00, surprisePrc: null },
          { date: '2025-06-01', epsActual: 2.00, surprisePrc: null },
        ],
      };
      const quote = { close: 200.00 };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      // trailingEps = 8.00, peRatio = 200 / 8 = 25.00
      expect(parseFloat(upsertCall.update.peRatio)).toBeCloseTo(25.0, 2);
    });

    it('sets peRatio to null when trailingEps is zero or negative', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: today, epsActual: -1.00, surprisePrc: null },
          { date: '2025-12-01', epsActual: 0.50, surprisePrc: null },
          { date: '2025-09-01', epsActual: -0.30, surprisePrc: null },
          { date: '2025-06-01', epsActual: 0.10, surprisePrc: null },
        ],
      };
      const quote = { close: 100.00 };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      // trailingEps = -1.0 + 0.5 - 0.3 + 0.1 = -0.70, peRatio should be null
      expect(upsertCall.update.peRatio).toBeNull();
    });

    it('computes annualizedDividendYield from dividends array', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const now = new Date();
      const sixMonthsAgo = new Date(now);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const dividends = {
        dividends: [
          { exDate: sixMonthsAgo.toISOString().split('T')[0], amount: 0.25 },
          { exDate: sixMonthsAgo.toISOString().split('T')[0], amount: 0.25 },
          { exDate: sixMonthsAgo.toISOString().split('T')[0], amount: 0.25 },
          { exDate: sixMonthsAgo.toISOString().split('T')[0], amount: 0.25 },
        ],
      };
      const quote = { close: 150.00 };

      await upsertFundamentals('AAPL', { earnings: null, dividends, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      // annualizedDividend = 1.00, yield = 1.00 / 150 = 0.006667
      expect(parseFloat(upsertCall.update.annualizedDividend)).toBeCloseTo(1.0, 2);
      expect(parseFloat(upsertCall.update.dividendYield)).toBeCloseTo(0.006667, 4);
    });

    it('excludes dividends older than 12 months', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const dividends = {
        dividends: [
          { exDate: '2020-01-01', amount: 5.00 }, // old, excluded
        ],
      };
      const quote = { close: 100.00 };

      await upsertFundamentals('AAPL', { earnings: null, dividends, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(parseFloat(upsertCall.update.annualizedDividend)).toBe(0);
      // dividendYield should be Decimal('0') when annualizedDividend is 0
      expect(parseFloat(upsertCall.update.dividendYield)).toBe(0);
    });

    it('stores latestEpsActual and latestEpsSurprise from most recent quarter', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: today, epsActual: 3.25, surprisePrc: 4.5 },
          { date: '2025-09-01', epsActual: 2.80, surprisePrc: 1.0 },
        ],
      };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote: null });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(parseFloat(upsertCall.update.latestEpsActual)).toBeCloseTo(3.25, 2);
      expect(parseFloat(upsertCall.update.latestEpsSurprise)).toBeCloseTo(4.5, 2);
    });

    it('stores week52High, week52Low, averageVolume from quote', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const quote = {
        close: 180.00,
        week52High: 200.00,
        week52Low: 120.00,
        averageVolume: 55_000_000,
        currency: 'USD',
      };

      await upsertFundamentals('AAPL', { earnings: null, dividends: null, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(parseFloat(upsertCall.update.week52High)).toBeCloseTo(200.0, 2);
      expect(parseFloat(upsertCall.update.week52Low)).toBeCloseTo(120.0, 2);
      expect(parseFloat(upsertCall.update.averageVolume)).toBe(55_000_000);
      expect(upsertCall.update.currency).toBe('USD');
    });

    it('filters out future-dated and null-eps earnings records', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: '2099-12-31', epsActual: 99.00, surprisePrc: null }, // future
          { date: today, epsActual: null, surprisePrc: null },          // null eps
          { date: today, epsActual: 2.00, surprisePrc: 1.0 },          // valid
        ],
      };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote: null });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      // Only 1 valid quarter, trailingEps = 2.00
      expect(parseFloat(upsertCall.update.trailingEps)).toBeCloseTo(2.0, 2);
    });

    it('handles prisma error gracefully without throwing', async () => {
      prisma.securityMaster.upsert.mockRejectedValue(new Error('DB error'));

      // Should not throw
      await expect(
        upsertFundamentals('AAPL', { earnings: null, dividends: null, quote: { close: 100 } })
      ).resolves.toBeUndefined();
    });
  });

  // ─── getAllActiveStockSymbols ──────────────────────────────────────────────
  describe('getAllActiveStockSymbols', () => {
    it('returns distinct symbols with exchange from portfolio items', async () => {
      prisma.portfolioItem.findMany.mockResolvedValue([
        { symbol: 'AAPL', exchange: 'XNAS' },
        { symbol: 'MSFT', exchange: null },
      ]);

      const result = await getAllActiveStockSymbols();

      expect(prisma.portfolioItem.findMany).toHaveBeenCalledWith({
        where: {
          quantity: { gt: 0 },
          category: { processingHint: 'API_STOCK' },
        },
        select: { symbol: true, exchange: true },
        distinct: ['symbol'],
      });
      expect(result).toEqual([
        { symbol: 'AAPL', exchange: 'XNAS' },
        { symbol: 'MSFT', exchange: null },
      ]);
    });
  });

  // ─── getAllSecurityMasterSymbols ───────────────────────────────────────────
  describe('getAllSecurityMasterSymbols', () => {
    it('returns all symbols ordered alphabetically', async () => {
      prisma.securityMaster.findMany.mockResolvedValue([
        { symbol: 'AAPL', exchange: 'XNAS' },
        { symbol: 'MSFT', exchange: 'XNAS' },
      ]);

      const result = await getAllSecurityMasterSymbols();

      expect(prisma.securityMaster.findMany).toHaveBeenCalledWith({
        select: { symbol: true, exchange: true },
        orderBy: { symbol: 'asc' },
      });
      expect(result).toEqual([
        { symbol: 'AAPL', exchange: 'XNAS' },
        { symbol: 'MSFT', exchange: 'XNAS' },
      ]);
    });
  });
});
