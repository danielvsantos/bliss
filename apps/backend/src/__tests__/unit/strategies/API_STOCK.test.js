// Mock all external dependencies before requiring the module under test
jest.mock('../../../services/stockService', () => ({
  getHistoricalStockPrice: jest.fn(),
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
const { getHistoricalStockPrice } = require('../../../services/stockService');
const prisma = require('../../../../prisma/prisma.js');

const { getPrice } = require('../../../workers/portfolio-handlers/valuation/strategies/API_STOCK');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makePortfolioItem = (overrides = {}) => ({
  symbol: 'AAPL',
  currency: 'USD',
  ...overrides,
});

const makePriceCaches = (overrides = {}) => ({
  dbPriceMap: new Map(),
  manualValueMap: new Map(),
  forwardPriceCache: new Map(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('API_STOCK strategy — getPrice()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Stage 1: Cache hit (forwardPriceCache) ──────────────────────────────

  describe('Stage 1: forwardPriceCache hit', () => {
    it('returns the cached price immediately without calling the API', async () => {
      const cachedResult = { price: new Decimal(175.50), source: 'DB:AssetPrice:ForwardFill' };
      const forwardPriceCache = new Map([['2026-03-02', cachedResult]]);
      const caches = makePriceCaches({ forwardPriceCache });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toBe(cachedResult);
      expect(getHistoricalStockPrice).not.toHaveBeenCalled();
      expect(prisma.assetPrice.upsert).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 1: Cache hit (dbPriceMap) ─────────────────────────────────────

  describe('Stage 1: dbPriceMap hit', () => {
    it('returns { price, source: "DB:AssetPrice" } from the DB price map', async () => {
      const dbEntry = { price: new Decimal(174.25) };
      const dbPriceMap = new Map([['2026-03-02', dbEntry]]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toEqual({ price: new Decimal(174.25), source: 'DB:AssetPrice' });
      expect(getHistoricalStockPrice).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 2: Live API call + DB save ────────────────────────────────────

  describe('Stage 2: Live API call', () => {
    it('calls getHistoricalStockPrice, saves to Prisma, and returns { price, source }', async () => {
      const apiResult = { price: new Decimal(176.00), source: 'API:TwelveData' };
      getHistoricalStockPrice.mockResolvedValue(apiResult);

      const savedRecord = {
        symbol: 'AAPL',
        assetType: 'API_STOCK',
        day: new Date('2026-03-02'),
        price: new Decimal(176.00),
        currency: 'USD',
      };
      prisma.assetPrice.upsert.mockResolvedValue(savedRecord);

      const caches = makePriceCaches();
      const item = makePortfolioItem();
      const targetDate = new Date('2026-03-02');

      const result = await getPrice(item, targetDate, caches);

      expect(getHistoricalStockPrice).toHaveBeenCalledWith('AAPL', targetDate, { exchange: undefined });
      expect(prisma.assetPrice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            symbol: 'AAPL',
            assetType: 'API_STOCK',
            day: targetDate,
            price: apiResult.price,
            currency: 'USD',
            exchange: '',
          }),
        })
      );
      expect(result).toEqual({ price: new Decimal(176.00), source: 'API:TwelveData' });
      // Verify the dbPriceMap was updated
      expect(caches.dbPriceMap.get('2026-03-02')).toBe(savedRecord);
    });
  });

  // ─── Stage 3: 7-day lookback on DB data ──────────────────────────────────

  describe('Stage 3: 7-day lookback on DB data', () => {
    it('finds a DB price within the 7-day lookback window and forward-fills', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);

      const dbPriceMap = new Map([
        ['2026-02-25', { price: new Decimal(170.00) }],
      ]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toEqual({ price: new Decimal(170.00), source: 'DB:AssetPrice:ForwardFill' });
      expect(caches.forwardPriceCache.get('2026-03-02')).toEqual({
        price: new Decimal(170.00),
        source: 'DB:AssetPrice:ForwardFill',
      });
    });

    it('does NOT find a DB price outside the 7-day lookback window', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);

      const dbPriceMap = new Map([
        ['2026-02-22', { price: new Decimal(170.00) }],
      ]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toBeNull();
    });

    it('returns null when no data exists at any stage', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);
      const caches = makePriceCaches();

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toBeNull();
    });
  });
});
