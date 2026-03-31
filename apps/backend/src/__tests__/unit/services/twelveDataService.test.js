// Mock all external dependencies before requiring the module under test
jest.mock('axios');
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const axios = require('axios');
const { Decimal } = require('@prisma/client/runtime/library');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('twelveDataService', () => {
  let twelveDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWELVE_DATA_API_KEY = 'test-api-key';
    // Re-require to pick up fresh env
    jest.resetModules();
    jest.mock('axios');
    jest.mock('../../../utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    twelveDataService = require('../../../services/twelveDataService');
  });

  afterEach(() => {
    delete process.env.TWELVE_DATA_API_KEY;
  });

  // ─── getHistoricalPrice ──────────────────────────────────────────────────

  describe('getHistoricalPrice()', () => {
    it('returns { price: Decimal, source: "API:TwelveData" } on success', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          values: [
            { datetime: '2026-03-02', close: '125.50' },
            { datetime: '2026-03-01', close: '124.00' },
          ],
        },
      });

      const result = await twelveDataService.getHistoricalPrice('AAPL', new Date('2026-03-02'));

      expect(result).not.toBeNull();
      expect(typeof result.price.toNumber).toBe('function');
      expect(result.price.toNumber()).toBe(125.50);
      expect(result.source).toBe('API:TwelveData');
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get).toHaveBeenCalledWith(
        'https://api.twelvedata.com/time_series',
        expect.objectContaining({
          params: expect.objectContaining({ symbol: 'AAPL', apikey: 'test-api-key' }),
          timeout: 10000,
        })
      );
    });

    it('uses weekend backtrack — values sorted desc, picks first entry', async () => {
      const axios = require('axios');
      // Simulate a weekend request: Sunday 2026-03-01
      // API returns only Friday's data since markets are closed on weekends
      axios.get.mockResolvedValue({
        data: {
          values: [
            { datetime: '2026-02-27', close: '130.00' }, // Friday (most recent)
          ],
        },
      });

      const result = await twelveDataService.getHistoricalPrice('VWCE.DEX', new Date('2026-03-01'));

      expect(result).not.toBeNull();
      expect(result.price.toNumber()).toBe(130.00);
      expect(result.source).toBe('API:TwelveData');
    });

    it('returns null when the API responds with an error status', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          status: 'error',
          message: 'Invalid symbol',
        },
      });

      const result = await twelveDataService.getHistoricalPrice('INVALID', new Date('2026-03-02'));

      expect(result).toBeNull();
    });

    it('returns null when TWELVE_DATA_API_KEY is not set', async () => {
      // Re-require without API key
      jest.resetModules();
      delete process.env.TWELVE_DATA_API_KEY;
      jest.mock('axios');
      jest.mock('../../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      const service = require('../../../services/twelveDataService');

      const result = await service.getHistoricalPrice('AAPL', new Date('2026-03-02'));

      expect(result).toBeNull();
      const axiosFresh = require('axios');
      expect(axiosFresh.get).not.toHaveBeenCalled();
    });

    it('returns null when axios throws a network error', async () => {
      const axios = require('axios');
      axios.get.mockRejectedValue(new Error('Network Error'));

      const result = await twelveDataService.getHistoricalPrice('AAPL', new Date('2026-03-02'));

      expect(result).toBeNull();
    });
  });

  // ─── getLatestPrice ──────────────────────────────────────────────────────

  describe('getLatestPrice()', () => {
    it('returns a number on success', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          close: '250.75',
        },
      });

      const result = await twelveDataService.getLatestPrice('AAPL');

      expect(typeof result).toBe('number');
      expect(result).toBe(250.75);
      expect(axios.get).toHaveBeenCalledWith(
        'https://api.twelvedata.com/quote',
        expect.objectContaining({
          params: expect.objectContaining({ symbol: 'AAPL', apikey: 'test-api-key' }),
          timeout: 10000,
        })
      );
    });

    it('returns null on error', async () => {
      const axios = require('axios');
      axios.get.mockRejectedValue(new Error('Timeout'));

      const result = await twelveDataService.getLatestPrice('AAPL');

      expect(result).toBeNull();
    });

    it('returns null when TWELVE_DATA_API_KEY is not set', async () => {
      jest.resetModules();
      delete process.env.TWELVE_DATA_API_KEY;
      jest.mock('axios');
      jest.mock('../../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      const service = require('../../../services/twelveDataService');

      const result = await service.getLatestPrice('AAPL');

      expect(result).toBeNull();
    });
  });

  // ─── searchSymbol ────────────────────────────────────────────────────────

  describe('searchSymbol()', () => {
    it('returns a mapped array of results', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          data: [
            {
              symbol: 'AAPL',
              instrument_name: 'Apple Inc',
              exchange: 'NASDAQ',
              country: 'United States',
              currency: 'USD',
              instrument_type: 'Common Stock',
              mic_code: 'XNGS',
            },
            {
              symbol: 'AAPL.MX',
              instrument_name: 'Apple Inc - Mexico',
              exchange: 'BMV',
              country: 'Mexico',
              currency: 'MXN',
              instrument_type: 'Common Stock',
              mic_code: 'XMEX',
            },
          ],
        },
      });

      const results = await twelveDataService.searchSymbol('AAPL');

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        symbol: 'AAPL',
        name: 'Apple Inc',
        exchange: 'NASDAQ',
        country: 'United States',
        currency: 'USD',
        type: 'Common Stock',
        mic_code: 'XNGS',
      });
      expect(results[1].symbol).toBe('AAPL.MX');
    });

    it('returns empty array when API returns no results', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          data: [],
        },
      });

      const results = await twelveDataService.searchSymbol('XYZNONEXIST');

      expect(results).toEqual([]);
    });

    it('returns empty array on error', async () => {
      const axios = require('axios');
      axios.get.mockRejectedValue(new Error('Service unavailable'));

      const results = await twelveDataService.searchSymbol('AAPL');

      expect(results).toEqual([]);
    });

    it('returns empty array when TWELVE_DATA_API_KEY is not set', async () => {
      jest.resetModules();
      delete process.env.TWELVE_DATA_API_KEY;
      jest.mock('axios');
      jest.mock('../../../utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }));
      const service = require('../../../services/twelveDataService');

      const results = await service.searchSymbol('AAPL');

      expect(results).toEqual([]);
    });
  });
});
