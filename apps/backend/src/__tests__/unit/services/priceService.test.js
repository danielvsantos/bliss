// ─── priceService.test.js ────────────────────────────────────────────────────
// Unit tests for getLatestPrice() — verifies API dispatch, provider source
// strings, currency threading for crypto, and DB fallback behaviour.

jest.mock('../../../services/stockService', () => ({
  getLatestStockPrice: jest.fn(),
  STOCK_PROVIDER: 'TWELVE_DATA',
}));
jest.mock('../../../services/cryptoService', () => ({
  getLatestCryptoPrice: jest.fn(),
}));
jest.mock('../../../../prisma/prisma.js', () => ({
  assetPrice: { findFirst: jest.fn() },
}));
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { getLatestPrice } = require('../../../services/priceService');
const { getLatestStockPrice } = require('../../../services/stockService');
const { getLatestCryptoPrice } = require('../../../services/cryptoService');
const prisma = require('../../../../prisma/prisma.js');

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('priceService — getLatestPrice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1. Returns TwelveData result for API_STOCK
  it('returns API:TwelveData result for API_STOCK', async () => {
    getLatestStockPrice.mockResolvedValue(175.50);

    const result = await getLatestPrice('AAPL', 'API_STOCK');

    expect(getLatestStockPrice).toHaveBeenCalledWith('AAPL', { exchange: undefined });
    expect(result).toEqual({ price: 175.50, source: 'API:TwelveData' });
  });

  // 2. Returns TwelveData result for API_FUND
  it('returns API:TwelveData result for API_FUND', async () => {
    getLatestStockPrice.mockResolvedValue(92.30);

    const result = await getLatestPrice('VTI', 'API_FUND');

    expect(getLatestStockPrice).toHaveBeenCalledWith('VTI', { exchange: undefined });
    expect(result).toEqual({ price: 92.30, source: 'API:TwelveData' });
  });

  // 3. Returns TwelveData result for API_CRYPTO with currency
  it('returns API:TwelveData result for API_CRYPTO', async () => {
    getLatestCryptoPrice.mockResolvedValue(64250.00);

    const result = await getLatestPrice('BTC', 'API_CRYPTO', 'EUR');

    expect(getLatestCryptoPrice).toHaveBeenCalledWith('BTC', 'EUR');
    expect(result).toEqual({ price: 64250.00, source: 'API:TwelveData' });
  });

  // 4. Passes undefined currency to cryptoService when not provided
  it('passes undefined currency when not provided', async () => {
    getLatestCryptoPrice.mockResolvedValue(64250.00);

    await getLatestPrice('BTC', 'API_CRYPTO');

    expect(getLatestCryptoPrice).toHaveBeenCalledWith('BTC', undefined);
  });

  // 5. Falls back to DB when API returns null (API_STOCK)
  it('falls back to DB when stockService returns null for API_STOCK', async () => {
    getLatestStockPrice.mockResolvedValue(null);
    prisma.assetPrice.findFirst.mockResolvedValue({
      symbol: 'AAPL',
      assetType: 'API_STOCK',
      price: { toNumber: () => 170.00 },
      day: new Date('2026-03-01'),
    });

    const result = await getLatestPrice('AAPL', 'API_STOCK');

    expect(getLatestStockPrice).toHaveBeenCalledWith('AAPL', { exchange: undefined });
    expect(prisma.assetPrice.findFirst).toHaveBeenCalledWith({
      where: { symbol: 'AAPL', assetType: 'API_STOCK' },
      orderBy: { day: 'desc' },
    });
    expect(result).toEqual({ price: 170.00, source: 'DB:AssetPrice' });
  });

  // 6. Returns null when both API and DB return nothing
  it('returns null when both API and DB return nothing', async () => {
    getLatestStockPrice.mockResolvedValue(null);
    prisma.assetPrice.findFirst.mockResolvedValue(null);

    const result = await getLatestPrice('AAPL', 'API_STOCK');

    expect(result).toBeNull();
  });

  // 7. Does not call cryptoService for API_STOCK
  it('does not call cryptoService for API_STOCK', async () => {
    getLatestStockPrice.mockResolvedValue(175.50);

    await getLatestPrice('AAPL', 'API_STOCK');

    expect(getLatestCryptoPrice).not.toHaveBeenCalled();
  });

  // 8. Does not call stockService for API_CRYPTO
  it('does not call stockService for API_CRYPTO', async () => {
    getLatestCryptoPrice.mockResolvedValue(64250.00);

    await getLatestPrice('BTC', 'API_CRYPTO');

    expect(getLatestStockPrice).not.toHaveBeenCalled();
  });

  // 9. Falls back to DB for API_CRYPTO when API returns null
  it('falls back to DB for API_CRYPTO when cryptoService returns null', async () => {
    getLatestCryptoPrice.mockResolvedValue(null);
    prisma.assetPrice.findFirst.mockResolvedValue({
      symbol: 'BTC',
      assetType: 'API_CRYPTO',
      price: { toNumber: () => 63000.00 },
      day: new Date('2026-03-01'),
    });

    const result = await getLatestPrice('BTC', 'API_CRYPTO', 'EUR');

    expect(getLatestCryptoPrice).toHaveBeenCalledWith('BTC', 'EUR');
    expect(prisma.assetPrice.findFirst).toHaveBeenCalledWith({
      where: { symbol: 'BTC', assetType: 'API_CRYPTO' },
      orderBy: { day: 'desc' },
    });
    expect(result).toEqual({ price: 63000.00, source: 'DB:AssetPrice' });
  });
});
