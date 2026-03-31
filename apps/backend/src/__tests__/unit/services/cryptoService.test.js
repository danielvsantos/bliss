// ─── cryptoService.test.js ────────────────────────────────────────────────────
// Unit tests for cryptoService: searchCrypto, getHistoricalCryptoPrice,
// getLatestCryptoPrice. Now delegates to twelveDataService (TwelveData API).

jest.mock('../../../services/twelveDataService', () => ({
  getHistoricalPrice: jest.fn(),
  getLatestPrice: jest.fn(),
  searchSymbol: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const twelveDataService = require('../../../services/twelveDataService');
const {
  getHistoricalCryptoPrice,
  getLatestCryptoPrice,
  searchCrypto,
} = require('../../../services/cryptoService');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('cryptoService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── searchCrypto ─────────────────────────────────────────────────────────

  describe('searchCrypto()', () => {
    it('returns empty array when twelveDataService returns empty', async () => {
      twelveDataService.searchSymbol.mockResolvedValue([]);

      const result = await searchCrypto('btc');

      expect(twelveDataService.searchSymbol).toHaveBeenCalledWith('btc');
      expect(result).toEqual([]);
    });

    it('filters for Digital Currency type and deduplicates by base symbol', async () => {
      twelveDataService.searchSymbol.mockResolvedValue([
        { symbol: 'BTC/USD', name: 'Bitcoin', exchange: 'Binance', country: '', currency: 'USD', type: 'Digital Currency', mic_code: '' },
        { symbol: 'BTC/EUR', name: 'Bitcoin', exchange: 'Binance', country: '', currency: 'EUR', type: 'Digital Currency', mic_code: '' },
        { symbol: 'BTC/GBP', name: 'Bitcoin', exchange: 'Binance', country: '', currency: 'GBP', type: 'Digital Currency', mic_code: '' },
      ]);

      const result = await searchCrypto('btc');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        symbol: 'BTC',
        name: 'Bitcoin',
        exchange: '',
        country: '',
        currency: '',
        type: 'Cryptocurrency',
        mic_code: '',
      });
    });

    it('excludes non-crypto results', async () => {
      twelveDataService.searchSymbol.mockResolvedValue([
        { symbol: 'BTC/USD', name: 'Bitcoin', exchange: 'Binance', country: '', currency: 'USD', type: 'Digital Currency', mic_code: '' },
        { symbol: 'GBTC', name: 'Grayscale Bitcoin Trust', exchange: 'NYSE', country: 'US', currency: 'USD', type: 'Common Stock', mic_code: 'XNYS' },
      ]);

      const result = await searchCrypto('btc');

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe('BTC');
    });

    it('limits results to the specified limit', async () => {
      twelveDataService.searchSymbol.mockResolvedValue([
        { symbol: 'BTC/USD', name: 'Bitcoin', type: 'Digital Currency', exchange: '', country: '', currency: 'USD', mic_code: '' },
        { symbol: 'ETH/USD', name: 'Ethereum', type: 'Digital Currency', exchange: '', country: '', currency: 'USD', mic_code: '' },
        { symbol: 'SOL/USD', name: 'Solana', type: 'Digital Currency', exchange: '', country: '', currency: 'USD', mic_code: '' },
      ]);

      const result = await searchCrypto('', 2);

      expect(result).toHaveLength(2);
    });

    it('returns results with type Cryptocurrency and empty currency', async () => {
      twelveDataService.searchSymbol.mockResolvedValue([
        { symbol: 'ETH/USD', name: 'Ethereum', exchange: 'Binance', country: '', currency: 'USD', type: 'Digital Currency', mic_code: '' },
      ]);

      const result = await searchCrypto('eth');

      expect(result[0]).toMatchObject({
        type: 'Cryptocurrency',
        exchange: '',
        currency: '',
      });
    });
  });

  // ─── getHistoricalCryptoPrice ─────────────────────────────────────────────

  describe('getHistoricalCryptoPrice()', () => {
    it('constructs pair with default USD and delegates to twelveDataService', async () => {
      const apiResult = { price: expect.any(Object), source: 'API:TwelveData' };
      twelveDataService.getHistoricalPrice.mockResolvedValue(apiResult);
      const date = new Date('2026-03-01');

      const result = await getHistoricalCryptoPrice('BTC', date);

      expect(twelveDataService.getHistoricalPrice).toHaveBeenCalledWith('BTC/USD', date);
      expect(result).toBe(apiResult);
    });

    it('constructs pair with specified currency', async () => {
      twelveDataService.getHistoricalPrice.mockResolvedValue(null);
      const date = new Date('2026-03-01');

      await getHistoricalCryptoPrice('ETH', date, 'EUR');

      expect(twelveDataService.getHistoricalPrice).toHaveBeenCalledWith('ETH/EUR', date);
    });

    it('returns null when twelveDataService returns null', async () => {
      twelveDataService.getHistoricalPrice.mockResolvedValue(null);

      const result = await getHistoricalCryptoPrice('DOGE', new Date('2026-03-01'));

      expect(result).toBeNull();
    });
  });

  // ─── getLatestCryptoPrice ─────────────────────────────────────────────────

  describe('getLatestCryptoPrice()', () => {
    it('constructs pair with default USD and delegates to twelveDataService', async () => {
      twelveDataService.getLatestPrice.mockResolvedValue(67000);

      const result = await getLatestCryptoPrice('BTC');

      expect(twelveDataService.getLatestPrice).toHaveBeenCalledWith('BTC/USD');
      expect(result).toBe(67000);
    });

    it('constructs pair with specified currency', async () => {
      twelveDataService.getLatestPrice.mockResolvedValue(62000);

      const result = await getLatestCryptoPrice('BTC', 'EUR');

      expect(twelveDataService.getLatestPrice).toHaveBeenCalledWith('BTC/EUR');
      expect(result).toBe(62000);
    });

    it('returns null when twelveDataService returns null', async () => {
      twelveDataService.getLatestPrice.mockResolvedValue(null);

      const result = await getLatestCryptoPrice('DOGE', 'BRL');

      expect(result).toBeNull();
    });
  });
});
