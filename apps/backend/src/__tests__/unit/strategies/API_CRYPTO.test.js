// Mock all external dependencies before requiring the module under test
jest.mock('../../../services/cryptoService', () => ({
  getHistoricalCryptoPrice: jest.fn(),
}));

jest.mock('../../../../prisma/prisma.js', () => ({
  assetPrice: {
    create: jest.fn(),
    upsert: jest.fn(),
  },
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { Decimal } = require('@prisma/client/runtime/library');
const { getHistoricalCryptoPrice } = require('../../../services/cryptoService');
const prisma = require('../../../../prisma/prisma.js');

const { getPrice } = require('../../../workers/portfolio-handlers/valuation/strategies/API_CRYPTO');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makePortfolioItem = (overrides = {}) => ({
  symbol: 'BTC',
  currency: 'USD',
  assetCurrency: 'EUR',
  ...overrides,
});

const makePriceCaches = (overrides = {}) => ({
  dbPriceMap: new Map(),
  manualValueMap: new Map(),
  forwardPriceCache: new Map(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('API_CRYPTO strategy — getPrice()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Stage 1: Cache hit (forwardPriceCache) ──────────────────────────────

  describe('Stage 1: forwardPriceCache hit', () => {
    it('returns the cached price immediately without calling the API', async () => {
      const cachedResult = { price: new Decimal(42000.00), source: 'DB:AssetPrice:ForwardFill' };
      const forwardPriceCache = new Map([['2026-03-02', cachedResult]]);
      const caches = makePriceCaches({ forwardPriceCache });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toBe(cachedResult);
      expect(getHistoricalCryptoPrice).not.toHaveBeenCalled();
      expect(prisma.assetPrice.upsert).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 1: Cache hit (dbPriceMap) ─────────────────────────────────────

  describe('Stage 1: dbPriceMap hit', () => {
    it('returns { price, source: "DB:AssetPrice" } from the DB price map', async () => {
      const dbEntry = { price: new Decimal(41500.00) };
      const dbPriceMap = new Map([['2026-03-02', dbEntry]]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toEqual({ price: new Decimal(41500.00), source: 'DB:AssetPrice' });
      expect(getHistoricalCryptoPrice).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 2: Live API call + DB save ────────────────────────────────────

  describe('Stage 2: Live API call', () => {
    it('calls getHistoricalCryptoPrice with currency, saves to Prisma, and returns result', async () => {
      const apiResult = { price: new Decimal(43000.00), source: 'API:TwelveData' };
      getHistoricalCryptoPrice.mockResolvedValue(apiResult);

      const savedRecord = {
        symbol: 'BTC',
        assetType: 'API_CRYPTO',
        day: new Date('2026-03-02'),
        price: new Decimal(43000.00),
        currency: 'USD',
      };
      prisma.assetPrice.upsert.mockResolvedValue(savedRecord);

      const caches = makePriceCaches();
      const item = makePortfolioItem({ assetCurrency: 'EUR' });
      const targetDate = new Date('2026-03-02');

      const result = await getPrice(item, targetDate, caches);

      // Should pass currency (assetCurrency takes priority over currency)
      expect(getHistoricalCryptoPrice).toHaveBeenCalledWith('BTC', targetDate, 'EUR');
      expect(prisma.assetPrice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            symbol: 'BTC',
            assetType: 'API_CRYPTO',
            day: targetDate,
            price: apiResult.price,
            currency: 'USD',
          }),
        })
      );
      expect(result).toEqual({ price: new Decimal(43000.00), source: 'API:TwelveData' });
    });

    it('falls back to portfolioItem.currency when assetCurrency is not set', async () => {
      const apiResult = { price: new Decimal(43000.00), source: 'API:TwelveData' };
      getHistoricalCryptoPrice.mockResolvedValue(apiResult);
      prisma.assetPrice.upsert.mockResolvedValue({});

      const item = makePortfolioItem({ assetCurrency: undefined, currency: 'BRL' });
      await getPrice(item, new Date('2026-03-02'), makePriceCaches());

      expect(getHistoricalCryptoPrice).toHaveBeenCalledWith('BTC', expect.any(Date), 'BRL');
    });

    it('updates dbPriceMap after saving to Prisma', async () => {
      const apiResult = { price: new Decimal(43000.00), source: 'API:TwelveData' };
      getHistoricalCryptoPrice.mockResolvedValue(apiResult);

      const savedRecord = { symbol: 'BTC', price: new Decimal(43000.00) };
      prisma.assetPrice.upsert.mockResolvedValue(savedRecord);

      const caches = makePriceCaches();
      await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(caches.dbPriceMap.get('2026-03-02')).toBe(savedRecord);
    });
  });

  // ─── Stage 3: 7-day lookback on DB data ──────────────────────────────────

  describe('Stage 3: 7-day lookback on DB data', () => {
    it('finds a DB price within the 7-day lookback window and forward-fills', async () => {
      getHistoricalCryptoPrice.mockResolvedValue(null);

      // Place a DB price 5 days before the target date
      const dbPriceMap = new Map([
        ['2026-02-25', { price: new Decimal(40000.00) }],
      ]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toEqual({ price: new Decimal(40000.00), source: 'DB:AssetPrice:ForwardFill' });
      expect(caches.forwardPriceCache.get('2026-03-02')).toEqual({
        price: new Decimal(40000.00),
        source: 'DB:AssetPrice:ForwardFill',
      });
    });

    it('does NOT find a DB price outside the 7-day lookback window', async () => {
      getHistoricalCryptoPrice.mockResolvedValue(null);

      // Place a DB price 8 days before the target date — outside the window
      const dbPriceMap = new Map([
        ['2026-02-22', { price: new Decimal(40000.00) }],
      ]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toBeNull();
    });

    it('returns null when no data exists at any stage', async () => {
      getHistoricalCryptoPrice.mockResolvedValue(null);
      const caches = makePriceCaches();

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toBeNull();
    });
  });
});
