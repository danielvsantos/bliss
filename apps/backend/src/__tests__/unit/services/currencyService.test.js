const axios = require('axios');
const { Decimal } = require('@prisma/client/runtime/library');

jest.mock('axios');
jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../../../services/twelveDataService');

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
// Pin the provider so this file's expectations (CurrencyLayer axios path,
// provider: 'currencylayer' on writes) are deterministic regardless of whether
// a real .env with TWELVE_DATA_API_KEY is present. The Twelve Data dispatch
// path is covered in its own describe block below via module re-require.
process.env.CURRENCY_PROVIDER = 'CURRENCYLAYER';
delete process.env.TWELVE_DATA_API_KEY;

const {
  fetchHistoricalRate,
  getOrCreateCurrencyRate,
  getRatesForDateRange,
  resolveCurrencyProvider,
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

// ---------------------------------------------------------------------------
// resolveCurrencyProvider() — precedence rules (reads process.env live)
// ---------------------------------------------------------------------------
describe('resolveCurrencyProvider()', () => {
  const saved = {};
  beforeEach(() => {
    saved.provider = process.env.CURRENCY_PROVIDER;
    saved.td = process.env.TWELVE_DATA_API_KEY;
    saved.cl = process.env.CURRENCYLAYER_API_KEY;
  });
  afterEach(() => {
    process.env.CURRENCY_PROVIDER = saved.provider;
    if (saved.td === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = saved.td;
    if (saved.cl === undefined) delete process.env.CURRENCYLAYER_API_KEY;
    else process.env.CURRENCYLAYER_API_KEY = saved.cl;
  });

  test('explicit CURRENCY_PROVIDER=TWELVE_DATA wins even with only a CurrencyLayer key', () => {
    process.env.CURRENCY_PROVIDER = 'TWELVE_DATA';
    delete process.env.TWELVE_DATA_API_KEY;
    process.env.CURRENCYLAYER_API_KEY = 'cl';
    expect(resolveCurrencyProvider()).toBe('TWELVE_DATA');
  });

  test('explicit CURRENCY_PROVIDER=CURRENCYLAYER wins even with a Twelve Data key', () => {
    process.env.CURRENCY_PROVIDER = 'currencylayer'; // case-insensitive
    process.env.TWELVE_DATA_API_KEY = 'td';
    expect(resolveCurrencyProvider()).toBe('CURRENCYLAYER');
  });

  test('no explicit provider: Twelve Data key present → TWELVE_DATA (even alongside CurrencyLayer key)', () => {
    delete process.env.CURRENCY_PROVIDER;
    process.env.TWELVE_DATA_API_KEY = 'td';
    process.env.CURRENCYLAYER_API_KEY = 'cl';
    expect(resolveCurrencyProvider()).toBe('TWELVE_DATA');
  });

  test('no explicit provider: only CurrencyLayer key present → CURRENCYLAYER (no silent FX loss on upgrade)', () => {
    delete process.env.CURRENCY_PROVIDER;
    delete process.env.TWELVE_DATA_API_KEY;
    process.env.CURRENCYLAYER_API_KEY = 'cl';
    expect(resolveCurrencyProvider()).toBe('CURRENCYLAYER');
  });

  test('no explicit provider, no keys → TWELVE_DATA default', () => {
    delete process.env.CURRENCY_PROVIDER;
    delete process.env.TWELVE_DATA_API_KEY;
    delete process.env.CURRENCYLAYER_API_KEY;
    expect(resolveCurrencyProvider()).toBe('TWELVE_DATA');
  });

  test('unrecognised CURRENCY_PROVIDER falls back to auto-detection', () => {
    process.env.CURRENCY_PROVIDER = 'bogus';
    process.env.TWELVE_DATA_API_KEY = 'td';
    expect(resolveCurrencyProvider()).toBe('TWELVE_DATA');
  });
});

// ---------------------------------------------------------------------------
// Provider dispatch — CURRENCY_PROVIDER=TWELVE_DATA
// (re-requires the module so the load-time ACTIVE_CURRENCY_PROVIDER capture
//  picks up the Twelve Data selection)
// ---------------------------------------------------------------------------
describe('fetchHistoricalRate() / getOrCreateCurrencyRate() — TWELVE_DATA provider', () => {
  let td;            // mocked twelveDataService
  let currencySvc;   // freshly required currencyService bound to TWELVE_DATA

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.CURRENCY_PROVIDER = 'TWELVE_DATA';
    process.env.TWELVE_DATA_API_KEY = 'td-test-key';

    jest.mock('axios');
    jest.mock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.mock('../../../services/twelveDataService');
    jest.mock('@prisma/client', () => ({
      PrismaClient: jest.fn().mockImplementation(() => ({ currencyRate: mockCurrencyRate })),
    }));

    td = require('../../../services/twelveDataService');
    currencySvc = require('../../../services/currencyService');
  });

  afterEach(() => {
    process.env.CURRENCY_PROVIDER = 'CURRENCYLAYER';
    delete process.env.TWELVE_DATA_API_KEY;
    jest.resetModules();
  });

  test('ACTIVE_CURRENCY_PROVIDER resolves to TWELVE_DATA', () => {
    expect(currencySvc.ACTIVE_CURRENCY_PROVIDER).toBe('TWELVE_DATA');
  });

  test('fetchHistoricalRate delegates to twelveDataService.getFxRate and makes no axios call', async () => {
    td.getFxRate.mockResolvedValue(1.0842);

    const result = await currencySvc.fetchHistoricalRate('2025-01-15', 'EUR', 'USD');

    expect(result).toBe(1.0842);
    expect(td.getFxRate).toHaveBeenCalledWith('EUR', 'USD', expect.any(Date));
    expect(require('axios').get).not.toHaveBeenCalled();
  });

  test('getOrCreateCurrencyRate miss persists the row with provider: "twelvedata"', async () => {
    jest.useRealTimers();

    mockCurrencyRate.findUnique.mockResolvedValue(null);
    mockCurrencyRate.create.mockResolvedValue({});
    td.getFxRate.mockResolvedValue(1.0842);
    const rateCache = {};

    const result = await currencySvc.getOrCreateCurrencyRate(
      new Date('2025-01-15T00:00:00.000Z'), 'EUR', 'USD', rateCache,
    );

    expect(result.toString()).toBe('1.0842');
    expect(mockCurrencyRate.create).toHaveBeenCalledTimes(1);
    const createArg = mockCurrencyRate.create.mock.calls[0][0].data;
    expect(createArg).toMatchObject({
      year: 2025,
      month: 1,
      day: 15,
      currencyFrom: 'EUR',
      currencyTo: 'USD',
      provider: 'twelvedata',
    });
    expect(createArg.value.toString()).toBe('1.0842');

    jest.useFakeTimers();
  });

  test('AC4: an existing DB row is returned without any Twelve Data call', async () => {
    const dbValue = new Decimal(1.10);
    mockCurrencyRate.findUnique.mockResolvedValue({ value: dbValue });

    const result = await currencySvc.getOrCreateCurrencyRate(
      new Date('2025-01-15T00:00:00.000Z'), 'EUR', 'USD', {},
    );

    expect(result).toEqual(dbValue);
    expect(td.getFxRate).not.toHaveBeenCalled();
    expect(require('axios').get).not.toHaveBeenCalled();
  });

  test('getOrCreateCurrencyRate caches null when Twelve Data returns null', async () => {
    mockCurrencyRate.findUnique.mockResolvedValue(null);
    td.getFxRate.mockResolvedValue(null);
    const rateCache = {};

    const result = await currencySvc.getOrCreateCurrencyRate(
      new Date('2025-01-15T00:00:00.000Z'), 'EUR', 'USD', rateCache,
    );

    expect(result).toBeNull();
    expect(rateCache['2025-01-15_EUR_USD']).toBeNull();
    expect(mockCurrencyRate.create).not.toHaveBeenCalled();
  });
});
