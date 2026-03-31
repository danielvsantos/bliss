// ─── stockService.test.js ─────────────────────────────────────────────────────
// stockService reads STOCK_PROVIDER at require-time, so we must set env
// and use jest.resetModules() + re-require to toggle between providers.

jest.mock('axios');
jest.mock('../../../services/twelveDataService', () => ({
  getHistoricalPrice: jest.fn(),
  getLatestPrice: jest.fn(),
}));
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { Decimal } = require('@prisma/client/runtime/library');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('stockService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.STOCK_PROVIDER;
    delete process.env.NEXT_PUBLIC_ALPHA_VANTAGE_API_KEY;
  });

  // ─── TWELVE_DATA provider ────────────────────────────────────────────────

  describe('when STOCK_PROVIDER=TWELVE_DATA', () => {
    let stockService;
    let twelveDataService;

    beforeEach(() => {
      jest.resetModules();
      process.env.STOCK_PROVIDER = 'TWELVE_DATA';
      jest.mock('axios');
      jest.mock('../../../services/twelveDataService', () => ({
        getHistoricalPrice: jest.fn(),
        getLatestPrice: jest.fn(),
      }));
      jest.mock('../../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      stockService = require('../../../services/stockService');
      twelveDataService = require('../../../services/twelveDataService');
    });

    it('getHistoricalStockPrice delegates to twelveDataService.getHistoricalPrice', async () => {
      const mockResult = { price: new Decimal(150.25), source: 'API:TwelveData' };
      twelveDataService.getHistoricalPrice.mockResolvedValue(mockResult);

      const date = new Date('2026-03-02');
      const result = await stockService.getHistoricalStockPrice('AAPL', date);

      expect(twelveDataService.getHistoricalPrice).toHaveBeenCalledWith('AAPL', date, { micCode: undefined });
      expect(result).toBe(mockResult);
    });

    it('getLatestStockPrice delegates to twelveDataService.getLatestPrice', async () => {
      twelveDataService.getLatestPrice.mockResolvedValue(250.75);

      const result = await stockService.getLatestStockPrice('AAPL');

      expect(twelveDataService.getLatestPrice).toHaveBeenCalledWith('AAPL', { micCode: undefined });
      expect(result).toBe(250.75);
    });
  });

  // ─── ALPHA_VANTAGE provider ──────────────────────────────────────────────

  describe('when STOCK_PROVIDER=ALPHA_VANTAGE', () => {
    let stockService;
    let axios;

    beforeEach(() => {
      jest.resetModules();
      process.env.STOCK_PROVIDER = 'ALPHA_VANTAGE';
      process.env.NEXT_PUBLIC_ALPHA_VANTAGE_API_KEY = 'av-test-key';
      jest.mock('axios');
      jest.mock('../../../services/twelveDataService', () => ({
        getHistoricalPrice: jest.fn(),
        getLatestPrice: jest.fn(),
      }));
      jest.mock('../../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      stockService = require('../../../services/stockService');
      axios = require('axios');
    });

    it('getHistoricalStockPrice calls Alpha Vantage and returns { price, source }', async () => {
      axios.get.mockResolvedValue({
        data: {
          'Time Series (Daily)': {
            '2026-03-02': { '4. close': '145.00' },
            '2026-03-01': { '4. close': '144.00' },
          },
        },
      });

      const result = await stockService.getHistoricalStockPrice('AAPL', new Date('2026-03-02'));

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('alphavantage.co'),
        expect.objectContaining({ timeout: 10000 })
      );
      expect(result).not.toBeNull();
      expect(typeof result.price.toNumber).toBe('function');
      expect(result.price.toNumber()).toBe(145.00);
      expect(result.source).toBe('API:AlphaVantage');
    });

    it('getHistoricalStockPrice returns null when time series is missing', async () => {
      axios.get.mockResolvedValue({
        data: {
          Note: 'API call frequency exceeded',
        },
      });

      const result = await stockService.getHistoricalStockPrice('AAPL', new Date('2026-03-02'));

      expect(result).toBeNull();
    });

    it('getHistoricalStockPrice returns null when API key is not set', async () => {
      jest.resetModules();
      process.env.STOCK_PROVIDER = 'ALPHA_VANTAGE';
      delete process.env.NEXT_PUBLIC_ALPHA_VANTAGE_API_KEY;
      jest.mock('axios');
      jest.mock('../../../services/twelveDataService', () => ({
        getHistoricalPrice: jest.fn(),
        getLatestPrice: jest.fn(),
      }));
      jest.mock('../../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      const svc = require('../../../services/stockService');

      const result = await svc.getHistoricalStockPrice('AAPL', new Date('2026-03-02'));

      expect(result).toBeNull();
    });

    it('getLatestStockPrice calls Alpha Vantage GLOBAL_QUOTE and returns a number', async () => {
      axios.get.mockResolvedValue({
        data: {
          'Global Quote': {
            '05. price': '260.50',
          },
        },
      });

      const result = await stockService.getLatestStockPrice('AAPL');

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('GLOBAL_QUOTE'),
        expect.objectContaining({ timeout: 10000 })
      );
      expect(typeof result).toBe('number');
      expect(result).toBe(260.50);
    });

    it('getLatestStockPrice returns null on network error', async () => {
      axios.get.mockRejectedValue(new Error('Network Error'));

      const result = await stockService.getLatestStockPrice('AAPL');

      expect(result).toBeNull();
    });
  });

  // ─── Default provider (ALPHA_VANTAGE when env is unset) ──────────────────

  describe('when STOCK_PROVIDER is not set (defaults to ALPHA_VANTAGE)', () => {
    it('does not delegate to twelveDataService', async () => {
      jest.resetModules();
      delete process.env.STOCK_PROVIDER;
      process.env.NEXT_PUBLIC_ALPHA_VANTAGE_API_KEY = 'av-test-key';
      jest.mock('axios');
      jest.mock('../../../services/twelveDataService', () => ({
        getHistoricalPrice: jest.fn(),
        getLatestPrice: jest.fn(),
      }));
      jest.mock('../../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      const svc = require('../../../services/stockService');
      const td = require('../../../services/twelveDataService');
      const ax = require('axios');

      ax.get.mockResolvedValue({
        data: {
          'Time Series (Daily)': {
            '2026-03-02': { '4. close': '100.00' },
          },
        },
      });

      await svc.getHistoricalStockPrice('MSFT', new Date('2026-03-02'));

      expect(td.getHistoricalPrice).not.toHaveBeenCalled();
      expect(ax.get).toHaveBeenCalled();
    });
  });
});
