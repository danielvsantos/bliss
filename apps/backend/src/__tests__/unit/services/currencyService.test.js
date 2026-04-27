const axios = require('axios');
const { Decimal } = require('@prisma/client/runtime/library');

jest.mock('axios');
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockCurrencyRate = {
  findUnique: jest.fn(),
  create: jest.fn(),
  findMany: jest.fn(),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    currencyRate: mockCurrencyRate,
  })),
}));

// Set before require() so the module-level capture picks up a truthy value.
// Without this, CI (which has no .env.test) would hit the guard clause and
// fetchHistoricalRate() would return null before reaching the mocked axios.
process.env.CURRENCYLAYER_API_KEY = 'test-key-for-unit-tests';

const {
  fetchHistoricalRate,
  getOrCreateCurrencyRate,
  getRatesForDateRange,
} = require('../../../services/currencyService');

jest.useFakeTimers();

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// fetchHistoricalRate
// ---------------------------------------------------------------------------
describe('fetchHistoricalRate()', () => {
  test('returns null when CURRENCYLAYER_API_KEY is not set', async () => {
    // The module captures the env var at load time, so we must re-require
    // with the var deleted to test this branch.
    jest.resetModules();

    const _originalKey = process.env.CURRENCYLAYER_API_KEY;
    delete process.env.CURRENCYLAYER_API_KEY;

    // Re-apply mocks after resetModules
    jest.mock('axios');
    jest.mock('../../../utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    jest.mock('@prisma/client', () => ({
      PrismaClient: jest.fn().mockImplementation(() => ({
        currencyRate: mockCurrencyRate,
      })),
    }));

    const { fetchHistoricalRate: freshFetch } = require('../../../services/currencyService');

    const result = await freshFetch('2025-01-15', 'USD', 'BRL');
    expect(result).toBeNull();

    // Restore env var for subsequent tests
    process.env.CURRENCYLAYER_API_KEY = 'test-key-for-unit-tests';
  });

  test('returns the rate on successful API call', async () => {
    axios.get.mockResolvedValue({
      data: { success: true, quotes: { USDBRL: 5.12 } },
    });

    const result = await fetchHistoricalRate('2025-01-15', 'USD', 'BRL');

    expect(result).toBe(5.12);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('date=2025-01-15'),
      { timeout: 10000 },
    );
  });

  test('returns null when API returns success: false', async () => {
    axios.get.mockResolvedValue({
      data: { success: false, error: { code: 202 } },
    });

    const result = await fetchHistoricalRate('2025-01-15', 'USD', 'BRL');
    expect(result).toBeNull();
  });

  test('returns null on network error', async () => {
    axios.get.mockRejectedValue(new Error('Network Error'));

    const result = await fetchHistoricalRate('2025-01-15', 'USD', 'BRL');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getOrCreateCurrencyRate
// ---------------------------------------------------------------------------
describe('getOrCreateCurrencyRate()', () => {
  const dateObj = new Date('2025-01-15T00:00:00.000Z');

  test('returns from in-memory cache when key exists', async () => {
    const cachedValue = new Decimal(5.12);
    const rateCache = { '2025-01-15_USD_BRL': cachedValue };

    const result = await getOrCreateCurrencyRate(dateObj, 'USD', 'BRL', rateCache);

    expect(result).toEqual(cachedValue);
    expect(mockCurrencyRate.findUnique).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('queries DB and caches if found', async () => {
    const dbValue = new Decimal(5.12);
    mockCurrencyRate.findUnique.mockResolvedValue({ value: dbValue });
    const rateCache = {};

    const result = await getOrCreateCurrencyRate(dateObj, 'USD', 'BRL', rateCache);

    expect(result).toEqual(dbValue);
    expect(rateCache['2025-01-15_USD_BRL']).toEqual(dbValue);
    expect(mockCurrencyRate.findUnique).toHaveBeenCalledWith({
      where: {
        year_month_day_currencyFrom_currencyTo: {
          year: 2025,
          month: 1,
          day: 15,
          currencyFrom: 'USD',
          currencyTo: 'BRL',
        },
      },
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('fetches from API, saves to DB, and caches when not in cache or DB', async () => {
    // Use real timers for this test since the function has a 50ms setTimeout
    // that interacts with multiple awaited async calls.
    jest.useRealTimers();

    mockCurrencyRate.findUnique.mockResolvedValue(null);
    mockCurrencyRate.create.mockResolvedValue({});
    axios.get.mockResolvedValue({
      data: { success: true, quotes: { USDBRL: 5.12 } },
    });
    const rateCache = {};

    const result = await getOrCreateCurrencyRate(dateObj, 'USD', 'BRL', rateCache);

    expect(result).toEqual(new Decimal(5.12));
    expect(rateCache['2025-01-15_USD_BRL']).toEqual(new Decimal(5.12));
    expect(mockCurrencyRate.create).toHaveBeenCalledWith({
      data: {
        year: 2025,
        month: 1,
        day: 15,
        currencyFrom: 'USD',
        currencyTo: 'BRL',
        value: new Decimal(5.12),
        provider: 'currencylayer',
      },
    });

    // Restore fake timers for remaining tests
    jest.useFakeTimers();
  });

  test('caches null on API failure and returns null', async () => {
    mockCurrencyRate.findUnique.mockResolvedValue(null);
    axios.get.mockRejectedValue(new Error('Network Error'));
    const rateCache = {};

    const result = await getOrCreateCurrencyRate(dateObj, 'USD', 'BRL', rateCache);

    expect(result).toBeNull();
    expect(rateCache['2025-01-15_USD_BRL']).toBeNull();
    expect(mockCurrencyRate.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getRatesForDateRange
// ---------------------------------------------------------------------------
describe('getRatesForDateRange()', () => {
  test('fetches rates year by year and returns a Map filtered by date range', async () => {
    const startDate = new Date('2025-01-10T00:00:00.000Z');
    const endDate = new Date('2025-01-20T00:00:00.000Z');

    mockCurrencyRate.findMany.mockResolvedValue([
      { year: 2025, month: 1, day: 5, value: new Decimal(5.0) },   // out of range
      { year: 2025, month: 1, day: 10, value: new Decimal(5.10) },  // in range
      { year: 2025, month: 1, day: 15, value: new Decimal(5.15) },  // in range
      { year: 2025, month: 1, day: 25, value: new Decimal(5.25) },  // out of range
    ]);

    const result = await getRatesForDateRange(startDate, endDate, 'USD', 'BRL');

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get('2025-01-10')).toEqual(new Decimal(5.10));
    expect(result.get('2025-01-15')).toEqual(new Decimal(5.15));
    expect(result.has('2025-01-05')).toBe(false);
    expect(result.has('2025-01-25')).toBe(false);
  });

  test('returns empty Map on error', async () => {
    const startDate = new Date('2025-01-10T00:00:00.000Z');
    const endDate = new Date('2025-01-20T00:00:00.000Z');

    mockCurrencyRate.findMany.mockRejectedValue(new Error('DB connection failed'));

    const result = await getRatesForDateRange(startDate, endDate, 'USD', 'BRL');

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});
