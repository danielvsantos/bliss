// Mock all external dependencies before requiring the module under test
jest.mock('axios');
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

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

  // ─── getEarnings ─────────────────────────────────────────────────────────
  // The /earnings endpoint returns inconsistent data across symbols
  // (unsorted arrays, malformed dates, far-future entries). The service
  // normalizes the response: sort newest-first, drop entries outside a
  // ±5y/+1y sanity window, and pass through everything else for the
  // service-layer (securityMasterService) to apply timezone-aware filtering.

  describe('getEarnings()', () => {
    /** Date n days from today in YYYY-MM-DD. */
    const offsetDate = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d.toISOString().split('T')[0];
    };

    it('sorts the earnings array newest-first regardless of API response order', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          meta: {},
          // Deliberately scrambled to prove we sort
          earnings: [
            { date: offsetDate(-200), eps_actual: '1.0' },
            { date: offsetDate(-30), eps_actual: '2.0' },
            { date: offsetDate(-110), eps_actual: '1.5' },
          ],
        },
      });

      const result = await twelveDataService.getEarnings('AAPL');

      expect(result.earnings).toHaveLength(3);
      expect(result.earnings[0].epsActual).toBe(2.0);
      expect(result.earnings[1].epsActual).toBe(1.5);
      expect(result.earnings[2].epsActual).toBe(1.0);
    });

    it('drops entries older than 5 years (sanity bound on past)', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          meta: {},
          earnings: [
            { date: offsetDate(-2000), eps_actual: '99.0' }, // ~5.5y old, dropped
            { date: offsetDate(-30), eps_actual: '2.0' },
          ],
        },
      });

      const result = await twelveDataService.getEarnings('AAPL');

      expect(result.earnings).toHaveLength(1);
      expect(result.earnings[0].epsActual).toBe(2.0);
    });

    it('drops entries more than 1 year in the future (sanity bound on future)', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          meta: {},
          earnings: [
            { date: offsetDate(400), eps_actual: '99.0' }, // >1y future, dropped
            { date: offsetDate(-30), eps_actual: '2.0' },
          ],
        },
      });

      const result = await twelveDataService.getEarnings('AAPL');

      expect(result.earnings).toHaveLength(1);
      expect(result.earnings[0].epsActual).toBe(2.0);
    });

    it('does NOT drop near-future entries (service layer handles the timezone grace)', async () => {
      // Earnings dated 1 day ahead must reach the service layer — same-day
      // reports in non-UTC timezones can appear with a +1 date offset, and
      // the upsert function applies a 24h grace window.
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          meta: {},
          earnings: [
            { date: offsetDate(1), eps_actual: '2.5' },
            { date: offsetDate(-90), eps_actual: '2.0' },
          ],
        },
      });

      const result = await twelveDataService.getEarnings('AAPL');

      expect(result.earnings).toHaveLength(2);
      expect(result.earnings[0].epsActual).toBe(2.5); // newest first
    });

    it('drops malformed date entries', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({
        data: {
          meta: {},
          earnings: [
            { date: 'not-a-date', eps_actual: '99.0' },
            { date: null, eps_actual: '88.0' },
            { date: offsetDate(-30), eps_actual: '2.0' },
          ],
        },
      });

      const result = await twelveDataService.getEarnings('AAPL');

      expect(result.earnings).toHaveLength(1);
      expect(result.earnings[0].epsActual).toBe(2.0);
    });
  });

  // ─── getFxRate ───────────────────────────────────────────────────────────
  // Twelve Data forex path used by currencyService when CURRENCY_PROVIDER is
  // TWELVE_DATA. Resolution order: /exchange_rate → /time_series backtrack →
  // inverse symbol. Direction: returns X where 1 FROM = X TO.

  describe('getFxRate()', () => {
    const PAST = new Date('2026-03-10T00:00:00.000Z'); // a Tuesday, safely historical

    it('returns the rate from /exchange_rate on success', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValueOnce({ data: { symbol: 'EUR/USD', rate: '1.0842' } });

      const result = await twelveDataService.getFxRate('EUR', 'USD', PAST);

      expect(result).toBe(1.0842);
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get).toHaveBeenCalledWith(
        'https://api.twelvedata.com/exchange_rate',
        expect.objectContaining({
          params: expect.objectContaining({ symbol: 'EUR/USD', apikey: 'test-api-key', date: '2026-03-10' }),
          timeout: 10000,
        })
      );
    });

    it('falls back to /time_series when /exchange_rate returns an error', async () => {
      const axios = require('axios');
      axios.get
        .mockResolvedValueOnce({ data: { status: 'error', message: 'No data' } })
        .mockResolvedValueOnce({ data: { values: [{ datetime: '2026-03-10', close: '1.0900' }] } });

      const result = await twelveDataService.getFxRate('EUR', 'USD', PAST);

      expect(result).toBe(1.09);
      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(axios.get).toHaveBeenLastCalledWith(
        'https://api.twelvedata.com/time_series',
        expect.objectContaining({
          params: expect.objectContaining({ symbol: 'EUR/USD', interval: '1day' }),
        })
      );
    });

    it('uses the weekend/holiday backtrack — picks values[0].close (Friday candle)', async () => {
      const axios = require('axios');
      // Saturday request: /exchange_rate has nothing, time_series returns only Friday
      axios.get
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValueOnce({ data: { values: [{ datetime: '2026-03-06', close: '1.0855' }] } });

      const result = await twelveDataService.getFxRate('EUR', 'USD', new Date('2026-03-07T00:00:00.000Z'));

      expect(result).toBe(1.0855);
    });

    it('resolves the inverse pair and inverts when the direct pair has no data', async () => {
      const axios = require('axios');
      axios.get
        .mockResolvedValueOnce({ data: {} })                                   // EUR/USD exchange_rate
        .mockResolvedValueOnce({ data: { values: [] } })                       // EUR/USD time_series
        .mockResolvedValueOnce({ data: { symbol: 'USD/EUR', rate: '1.08' } }); // USD/EUR exchange_rate

      const result = await twelveDataService.getFxRate('EUR', 'USD', PAST);

      expect(result).toBeCloseTo(1 / 1.08, 10);
      expect(axios.get).toHaveBeenCalledTimes(3);
    });

    it('returns null (and makes no HTTP calls) when TWELVE_DATA_API_KEY is not set', async () => {
      jest.resetModules();
      delete process.env.TWELVE_DATA_API_KEY;
      jest.mock('axios');
      jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      const service = require('../../../services/twelveDataService');

      const result = await service.getFxRate('EUR', 'USD', PAST);

      expect(result).toBeNull();
      expect(require('axios').get).not.toHaveBeenCalled();
    });

    it('returns null when every path fails', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValue({ data: {} });

      const result = await twelveDataService.getFxRate('EUR', 'USD', PAST);

      expect(result).toBeNull();
      expect(axios.get).toHaveBeenCalledTimes(4); // direct exchange_rate + time_series, inverse exchange_rate + time_series
    });

    it('requests the real-time rate (no date param) when date is today', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValueOnce({ data: { symbol: 'GBP/USD', rate: '1.27' } });

      const result = await twelveDataService.getFxRate('GBP', 'USD', new Date());

      expect(result).toBe(1.27);
      const params = axios.get.mock.calls[0][1].params;
      expect(params).not.toHaveProperty('date');
    });

    it('short-circuits to 1 when both currencies are identical', async () => {
      const axios = require('axios');
      const result = await twelveDataService.getFxRate('USD', 'USD', PAST);
      expect(result).toBe(1);
      expect(axios.get).not.toHaveBeenCalled();
    });
  });
});
