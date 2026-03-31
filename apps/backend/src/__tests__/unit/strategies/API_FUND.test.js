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

const { getPrice } = require('../../../workers/portfolio-handlers/valuation/strategies/API_FUND');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makePortfolioItem = (overrides = {}) => ({
  symbol: 'VWCE.DEX',
  currency: 'EUR',
  ...overrides,
});

const makePriceCaches = (overrides = {}) => ({
  dbPriceMap: new Map(),
  manualValueMap: new Map(),
  forwardPriceCache: new Map(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('API_FUND strategy — getPrice()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Stage 1: Cache hit (forwardPriceCache) ──────────────────────────────

  describe('Stage 1: forwardPriceCache hit', () => {
    it('returns the cached price immediately without calling the API', async () => {
      const cachedResult = { price: new Decimal(100.50), source: 'DB:AssetPrice:ForwardFill' };
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
      const dbEntry = { price: new Decimal(95.25) };
      const dbPriceMap = new Map([['2026-03-02', dbEntry]]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toEqual({ price: new Decimal(95.25), source: 'DB:AssetPrice' });
      expect(getHistoricalStockPrice).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 2: Live API call + DB save ────────────────────────────────────

  describe('Stage 2: Live API call', () => {
    it('calls getHistoricalStockPrice, saves to prisma, and returns { price, source }', async () => {
      const apiResult = { price: new Decimal(110.00), source: 'API:TwelveData' };
      getHistoricalStockPrice.mockResolvedValue(apiResult);

      const savedRecord = {
        symbol: 'VWCE.DEX',
        assetType: 'API_FUND',
        day: new Date('2026-03-02'),
        price: new Decimal(110.00),
        currency: 'EUR',
      };
      prisma.assetPrice.upsert.mockResolvedValue(savedRecord);

      const caches = makePriceCaches();
      const item = makePortfolioItem();
      const targetDate = new Date('2026-03-02');

      const result = await getPrice(item, targetDate, caches);

      expect(getHistoricalStockPrice).toHaveBeenCalledWith('VWCE.DEX', targetDate, { exchange: undefined });
      expect(prisma.assetPrice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            symbol: 'VWCE.DEX',
            assetType: 'API_FUND',
            day: targetDate,
            price: apiResult.price,
            currency: 'EUR',
            exchange: '',
          }),
        })
      );
      expect(result).toEqual({ price: new Decimal(110.00), source: 'API:TwelveData' });
      // Verify the dbPriceMap was updated for future lookups
      expect(caches.dbPriceMap.get('2026-03-02')).toBe(savedRecord);
    });
  });

  // ─── Stage 2: MANUAL source skips API ────────────────────────────────────

  describe('Stage 2: MANUAL source skips API call', () => {
    it('skips getHistoricalStockPrice when source is MANUAL', async () => {
      const caches = makePriceCaches();
      const item = makePortfolioItem({ source: 'MANUAL', symbol: 'Funds:PIC 33/60' });

      const result = await getPrice(item, new Date('2026-03-02'), caches);

      expect(getHistoricalStockPrice).not.toHaveBeenCalled();
      expect(result).toBeNull(); // No manual values either → null
    });

    it('still calls API when source is SYNCED', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);
      const caches = makePriceCaches();
      const item = makePortfolioItem({ source: 'SYNCED' });

      await getPrice(item, new Date('2026-03-02'), caches);

      expect(getHistoricalStockPrice).toHaveBeenCalledWith('VWCE.DEX', expect.any(Date), { exchange: undefined });
    });
  });

  // ─── Stage 4: Graceful fallback to manualValueMap ────────────────────────

  describe('Stage 4: Graceful fallback to manualValueMap', () => {
    it('returns manual value when API returns null and manual value exists for exact date', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);

      const manualValueMap = new Map([
        ['2026-03-02', { value: new Decimal(5000.00) }],
      ]);
      const caches = makePriceCaches({ manualValueMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toEqual({ price: new Decimal(5000.00), source: 'ManualValue:ExactDate' });
    });

    it('returns manual value forward-fill when API returns null and prior manual value exists', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);

      const manualValueMap = new Map([
        ['2026-02-28', { value: new Decimal(4800.00) }],
      ]);
      const caches = makePriceCaches({ manualValueMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toEqual({ price: new Decimal(4800.00), source: 'ManualValue:ForwardFill' });
      // forwardPriceCache should be populated
      expect(caches.forwardPriceCache.get('2026-03-02')).toEqual({
        price: new Decimal(4800.00),
        source: 'ManualValue:ForwardFill',
      });
    });

    it('returns null when API fails and no manual values exist', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);
      const caches = makePriceCaches();

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toBeNull();
    });

    it('uses unlimited lookback beyond 7 days for manual values', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);

      // Place a manual value 30 days before target — well beyond 7-day window
      const manualValueMap = new Map([
        ['2026-02-01', { value: new Decimal(9500.00) }],
      ]);
      const caches = makePriceCaches({ manualValueMap });

      const result = await getPrice(
        makePortfolioItem({ source: 'MANUAL' }),
        new Date('2026-03-02'),
        caches,
      );

      expect(result).toEqual({ price: new Decimal(9500.00), source: 'ManualValue:ForwardFill' });
      expect(caches.forwardPriceCache.get('2026-03-02')).toEqual({
        price: new Decimal(9500.00),
        source: 'ManualValue:ForwardFill',
      });
    });
  });

  // ─── Stage 3: 7-day lookback on DB data ──────────────────────────────────

  describe('Stage 3: 7-day lookback on DB data', () => {
    it('finds a DB price within the 7-day lookback window and forward-fills', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);

      // Place a DB price 5 days before the target date
      const dbPriceMap = new Map([
        ['2026-02-25', { price: new Decimal(88.00) }],
      ]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      expect(result).toEqual({ price: new Decimal(88.00), source: 'DB:AssetPrice:ForwardFill' });
      expect(caches.forwardPriceCache.get('2026-03-02')).toEqual({
        price: new Decimal(88.00),
        source: 'DB:AssetPrice:ForwardFill',
      });
    });

    it('does NOT find a DB price outside the 7-day lookback window', async () => {
      getHistoricalStockPrice.mockResolvedValue(null);

      // Place a DB price 8 days before the target date — outside the window
      const dbPriceMap = new Map([
        ['2026-02-22', { price: new Decimal(88.00) }],
      ]);
      const caches = makePriceCaches({ dbPriceMap });

      const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

      // Should fall through to Stage 4 (manualValueMap is empty → null)
      expect(result).toBeNull();
    });
  });
});
