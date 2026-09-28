// ─── securityMasterService.test.js ──────────────────────────────────────────
// Unit tests for SecurityMaster service: getBySymbol, getBySymbols,
// upsertFromProfile, upsertFundamentals, getAllActiveSecuritySymbols,
// getTenantSecuritySymbols,
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
  upsertEtfComposition,
  getAllActiveSecuritySymbols,
  getTenantSecuritySymbols,
  getAllSecurityMasterSymbols,
  isEtfAssetType,
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

  // ─── upsertEtfComposition (#79) ─────────────────────────────────────────────
  describe('upsertEtfComposition', () => {
    it('stores a normalized composition and stamps lastCompositionUpdate', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});
      await upsertEtfComposition('VWCE', {
        sectors: [{ sector: 'Technology', weight: 25 }, { sector: 'Financials', weight: 15 }],
        countries: [{ country: 'United States', weight: 62 }],
        assetAllocation: { stocks: 99.5, cash: 0.5 },
        creditsUsed: 1,
      });
      const { where, update, create } = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(where).toEqual({ symbol: 'VWCE' });
      expect(update.etfComposition.sectors[0]).toEqual({ sector: 'Technology', weight: 0.25 });
      expect(update.etfComposition.countries).toEqual([{ country: 'United States', weight: 0.62 }]);
      expect(update.etfComposition.assetAllocation.stocks).toBeCloseTo(0.995);
      expect(update.etfComposition).not.toHaveProperty('creditsUsed');
      expect(update.lastCompositionUpdate).toBeInstanceOf(Date);
      expect(create.symbol).toBe('VWCE');
    });
  });

  // ─── upsertFromProfile ────────────────────────────────────────────────────
  describe('upsertFromProfile', () => {
    it('ignores the profile sector, industry and country for ETFs', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      await upsertFromProfile('VWCE', {
        name: 'Vanguard FTSE All-World',
        sector: 'Basic Materials',
        industry: 'Specialty Chemicals',
        country: 'Netherlands',
        micCode: 'XETR',
        type: 'ETF',
      });

      const call = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(call.update).toEqual(expect.objectContaining({ sector: null, industry: null, country: null, assetType: 'ETF' }));
    });

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

    it('omits peRatio update when trailingEps is non-positive (preserves previous, marks untrusted)', async () => {
      // Behavior change: a previous version explicitly wrote `null` to peRatio
      // when trailingEps was non-positive, which silently wiped a prior good
      // value if a single bad refresh hit a transient API quirk. The new
      // behavior is to omit peRatio from the update payload — the previous
      // value is preserved on the row, but earningsTrusted is set to false
      // so consumers ignore it.
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
      // trailingEps = -1.0 + 0.5 - 0.3 + 0.1 = -0.70 → no peRatio in payload
      expect(upsertCall.update.peRatio).toBeUndefined();
      expect(upsertCall.update.earningsTrusted).toBe(false);
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

    it('excludes dividends older than 12 months and marks dividendTrusted=false', async () => {
      // A stock with only old dividend history is the "stopped paying or stale
      // data" case — we can't tell which from the response alone, so we mark
      // untrusted and let consumers hide it.
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
      expect(upsertCall.update.dividendTrusted).toBe(false);
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

    // ─── Trust gate ─────────────────────────────────────────────────────────
    // Twelve Data's earnings/dividend responses are inconsistent across
    // symbols (timezone skew, sparse history, stale quarters). The trust
    // flags decide whether downstream consumers (insights LLM, equity
    // analysis page) can use the computed fields.

    /** Date n days ago in YYYY-MM-DD form. */
    const daysAgo = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d.toISOString().split('T')[0];
    };

    /** Date n days in the future in YYYY-MM-DD form. */
    const daysFromNow = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d.toISOString().split('T')[0];
    };

    it('marks earningsTrusted=true when 4 fresh quarters + computed peRatio', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: daysAgo(30), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(120), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(210), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(300), epsActual: 2.0, surprisePrc: null },
        ],
      };
      const quote = { close: 200.00 };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.earningsTrusted).toBe(true);
      expect(parseFloat(upsertCall.update.peRatio)).toBeCloseTo(25.0, 2);
    });

    it('marks earningsTrusted=false when fewer than 4 quarters available', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: daysAgo(30), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(120), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(210), epsActual: 2.0, surprisePrc: null },
        ],
      };
      const quote = { close: 200.00 };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.earningsTrusted).toBe(false);
    });

    it('marks earningsTrusted=false when newest quarter is older than 180 days (stale)', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      // Newest quarter is 200 days old → stale, even though we have 4 quarters
      const earnings = {
        earnings: [
          { date: daysAgo(200), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(290), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(380), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(470), epsActual: 2.0, surprisePrc: null },
        ],
      };
      const quote = { close: 200.00 };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.earningsTrusted).toBe(false);
    });

    it('marks earningsTrusted=false when 4 quarters span more than 450 days (sparse)', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      // 4 quarters spanning 460 days — the gap suggests missing data, not a
      // real reporting cadence. Don't trust derived metrics.
      const earnings = {
        earnings: [
          { date: daysAgo(0), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(100), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(200), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(460), epsActual: 2.0, surprisePrc: null },
        ],
      };
      const quote = { close: 200.00 };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.earningsTrusted).toBe(false);
    });

    it('marks earningsTrusted=false and preserves previous trailingEps when no earnings data', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      await upsertFundamentals('AAPL', { earnings: null, dividends: null, quote: { close: 100 } });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.earningsTrusted).toBe(false);
      // trailingEps must not appear in the update payload — prior row value
      // is preserved by Prisma's partial-update semantics.
      expect(upsertCall.update.trailingEps).toBeUndefined();
      expect(upsertCall.update.peRatio).toBeUndefined();
    });

    it('uses 24h grace window to accept same-day earnings dated tomorrow (timezone fix)', async () => {
      // Twelve Data returns dates in the stock's exchange timezone. A 4:30 PM
      // ET earnings call dated `today` (in ET) can appear as `tomorrow` when
      // this job runs at midnight UTC the previous day. The 24h grace
      // absorbs that skew.
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: daysFromNow(1), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(90), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(180), epsActual: 2.0, surprisePrc: null },
          { date: daysAgo(270), epsActual: 2.0, surprisePrc: null },
        ],
      };
      const quote = { close: 200.00 };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      // The +1d entry was accepted: trailingEps reflects all 4 quarters
      expect(parseFloat(upsertCall.update.trailingEps)).toBeCloseTo(8.0, 2);
      expect(upsertCall.update.earningsTrusted).toBe(true);
    });

    it('rejects earnings dated more than one day in the future (beyond grace window)', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const earnings = {
        earnings: [
          { date: daysFromNow(60), epsActual: 99.0, surprisePrc: null }, // future, rejected
          { date: daysAgo(30), epsActual: 2.0, surprisePrc: null },
        ],
      };

      await upsertFundamentals('AAPL', { earnings, dividends: null, quote: null });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      // Only the past-dated quarter contributed → trailingEps = 2.0
      expect(parseFloat(upsertCall.update.trailingEps)).toBeCloseTo(2.0, 2);
    });

    it('marks dividendTrusted=true when stock has no dividend history (correct zero)', async () => {
      // Empty dividend response for a non-dividend stock — zero IS the right
      // answer here, so the row is trusted.
      prisma.securityMaster.upsert.mockResolvedValue({});

      await upsertFundamentals('AAPL', {
        earnings: null,
        dividends: { dividends: [] },
        quote: { close: 100 },
      });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.dividendTrusted).toBe(true);
      expect(parseFloat(upsertCall.update.annualizedDividend)).toBe(0);
      expect(parseFloat(upsertCall.update.dividendYield)).toBe(0);
    });

    it('marks dividendTrusted=true when recent dividends + valid price', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const dividends = {
        dividends: [
          { exDate: daysAgo(30), amount: 0.25 },
          { exDate: daysAgo(120), amount: 0.25 },
          { exDate: daysAgo(210), amount: 0.25 },
          { exDate: daysAgo(300), amount: 0.25 },
        ],
      };
      const quote = { close: 100.00 };

      await upsertFundamentals('AAPL', { earnings: null, dividends, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.dividendTrusted).toBe(true);
      expect(parseFloat(upsertCall.update.annualizedDividend)).toBeCloseTo(1.0, 2);
    });

    it('marks dividendTrusted=false when most recent ex-date is older than 180 days', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const dividends = {
        dividends: [
          { exDate: daysAgo(200), amount: 0.50 }, // within 12mo but >180d → stale
          { exDate: daysAgo(300), amount: 0.50 },
        ],
      };
      const quote = { close: 100.00 };

      await upsertFundamentals('AAPL', { earnings: null, dividends, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.dividendTrusted).toBe(false);
    });

    it('marks dividendTrusted=false when recent dividends but no current price', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      const dividends = {
        dividends: [
          { exDate: daysAgo(30), amount: 0.25 },
          { exDate: daysAgo(120), amount: 0.25 },
        ],
      };

      await upsertFundamentals('AAPL', { earnings: null, dividends, quote: null });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update.dividendTrusted).toBe(false);
    });

    // Full-history responses (range=full): only the trailing 365 days count.
    it('quarterly payer (KO-like full history) → annual = sum of last 4 payments', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});
      const quote = { close: 70 };
      const dividends = {
        dividends: [
          { exDate: daysAgo(12), amount: 0.53 },
          { exDate: daysAgo(104), amount: 0.53 },
          { exDate: daysAgo(195), amount: 0.51 },
          { exDate: daysAgo(286), amount: 0.51 },
          // Older history — must be ignored
          { exDate: daysAgo(377), amount: 0.51 },
          { exDate: daysAgo(468), amount: 0.485 },
          { exDate: daysAgo(3000), amount: 0.3 },
        ],
      };

      await upsertFundamentals('KO', { earnings: null, dividends, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(parseFloat(upsertCall.update.annualizedDividend)).toBeCloseTo(2.08, 4);
      expect(parseFloat(upsertCall.update.dividendYield)).toBeCloseTo(2.08 / 70, 5);
      expect(upsertCall.update.dividendTrusted).toBe(true);
    });

    it('monthly payer (O-like full history) → annual = sum of last 12 payments', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});
      const quote = { close: 58 };
      const monthly = Array.from({ length: 24 }, (_, i) => ({
        exDate: daysAgo(i < 12 ? 5 + i * 30 : 400 + (i - 12) * 30),
        amount: i < 12 ? 0.2685 : 0.2565,
      }));

      await upsertFundamentals('O', { earnings: null, dividends: { dividends: monthly }, quote });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      // recentDividends stores the same 12 payments, newest first (#77)
      expect(upsertCall.update.recentDividends).toHaveLength(12);
      expect(upsertCall.update.recentDividends[0]).toEqual({ exDate: daysAgo(5), amount: 0.2685 });
      expect(upsertCall.update.recentDividends[0].exDate > upsertCall.update.recentDividends[11].exDate).toBe(true);
      expect(parseFloat(upsertCall.update.annualizedDividend)).toBeCloseTo(12 * 0.2685, 4);
      expect(parseFloat(upsertCall.update.dividendYield)).toBeCloseTo((12 * 0.2685) / 58, 5);
      expect(upsertCall.update.dividendTrusted).toBe(true);
    });

    it('excludes announced future ex-dates from the trailing-12-month sum', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});
      const future = new Date();
      future.setDate(future.getDate() + 20);
      const dividends = {
        dividends: [
          { exDate: future.toISOString().split('T')[0], amount: 0.53 },
          { exDate: daysAgo(70), amount: 0.53 },
          { exDate: daysAgo(160), amount: 0.51 },
          { exDate: daysAgo(250), amount: 0.51 },
          { exDate: daysAgo(340), amount: 0.51 },
        ],
      };

      await upsertFundamentals('KO', { earnings: null, dividends, quote: { close: 70 } });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(parseFloat(upsertCall.update.annualizedDividend)).toBeCloseTo(2.06, 4);
    });

    it('accumulating ETF (empty full history) → zero annual dividend and yield, trusted', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});

      await upsertFundamentals('VWCE', { earnings: null, dividends: { dividends: [] }, quote: { close: 120 } });

      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(parseFloat(upsertCall.update.annualizedDividend)).toBe(0);
      expect(parseFloat(upsertCall.update.dividendYield)).toBe(0);
      expect(upsertCall.update.dividendTrusted).toBe(true);
      expect(upsertCall.update.recentDividends).toEqual([]); // trusted zero
    });

    it('keeps the previous recentDividends when the dividend fetch failed', async () => {
      prisma.securityMaster.upsert.mockResolvedValue({});
      await upsertFundamentals('KO', { earnings: null, dividends: null, quote: { close: 70 } });
      const upsertCall = prisma.securityMaster.upsert.mock.calls[0][0];
      expect(upsertCall.update).not.toHaveProperty('recentDividends');
      expect(upsertCall.update.dividendTrusted).toBe(false);
    });
  });

  // ─── getAllActiveSecuritySymbols (stocks + ETFs, #77) ─────────────────────
  describe('getAllActiveSecuritySymbols', () => {
    it('returns stocks, ETFs and not-yet-profiled funds; skips known mutual funds; dedupes', async () => {
      prisma.portfolioItem.findMany.mockResolvedValue([
        { symbol: 'AAPL', exchange: 'XNAS', category: { processingHint: 'API_STOCK' } },
        { symbol: 'AAPL', exchange: 'XNAS', category: { processingHint: 'API_STOCK' } },
        { symbol: 'VWCE', exchange: 'XETR', category: { processingHint: 'API_FUND' } },
        { symbol: 'VFIAX', exchange: null, category: { processingHint: 'API_FUND' } },
        { symbol: 'NEWFUND', exchange: null, category: { processingHint: 'API_FUND' } },
      ]);
      prisma.securityMaster.findMany.mockResolvedValue([
        { symbol: 'VWCE', assetType: 'ETF' },
        { symbol: 'VFIAX', assetType: 'Mutual Fund' },
      ]);

      const result = await getAllActiveSecuritySymbols();

      expect(prisma.portfolioItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { quantity: { gt: 0 }, category: { processingHint: { in: ['API_STOCK', 'API_FUND'] } } },
      }));
      expect(result).toEqual([
        { symbol: 'AAPL', exchange: 'XNAS' },
        { symbol: 'VWCE', exchange: 'XETR' },
        { symbol: 'NEWFUND', exchange: null },
      ]);
    });
  });

  describe('getTenantSecuritySymbols', () => {
    const items = [
      { symbol: 'KO', exchange: 'XNYS', category: { processingHint: 'API_STOCK' } },
      { symbol: 'O', exchange: 'XNYS', category: { processingHint: 'API_STOCK' } },
      { symbol: 'NEW', exchange: null, category: { processingHint: 'API_STOCK' } },
    ];

    it('requires tenantId', async () => {
      await expect(getTenantSecuritySymbols()).rejects.toThrow('tenantId is required');
    });

    it('scopes to the tenant and returns only missing or stale symbols by default', async () => {
      prisma.portfolioItem.findMany.mockResolvedValue(items);
      prisma.securityMaster.findMany.mockResolvedValue([
        { symbol: 'KO', lastFundamentalsUpdate: new Date() },
        { symbol: 'O', lastFundamentalsUpdate: new Date(Date.now() - 10 * 86400000) },
      ]);

      const result = await getTenantSecuritySymbols('t1');

      expect(prisma.portfolioItem.findMany.mock.calls[0][0].where.tenantId).toBe('t1');
      expect(result.map((r) => r.symbol)).toEqual(['O', 'NEW']);
    });

    it('returns every symbol with force', async () => {
      prisma.portfolioItem.findMany.mockResolvedValue(items);
      const result = await getTenantSecuritySymbols('t1', { force: true });
      expect(result.map((r) => r.symbol)).toEqual(['KO', 'O', 'NEW']);
      expect(prisma.securityMaster.findMany).not.toHaveBeenCalled();
    });
  });

  describe('isEtfAssetType', () => {
    it('matches the Twelve Data ETF type only', () => {
      expect(isEtfAssetType('ETF')).toBe(true);
      expect(isEtfAssetType(' etf ')).toBe(true);
      expect(isEtfAssetType('Common Stock')).toBe(false);
      expect(isEtfAssetType(null)).toBe(false);
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
