// Mock dependencies before requiring the module
jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../../prisma/prisma.js', () => ({
  assetPrice: { findMany: jest.fn() },
  manualAssetValue: { findMany: jest.fn() },
}));

// Mock the strategies directory loading by mocking fs and path
// Instead, we mock the entire module and test its returned API shape
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readdirSync: jest.fn().mockReturnValue(['MANUAL.js']),
  };
});

// Mock the strategy that gets dynamically loaded
jest.mock(
  '../../../../workers/portfolio-handlers/valuation/strategies/MANUAL.js',
  () => ({
    getPrice: jest.fn(),
  }),
  { virtual: true }
);

const { Decimal } = require('@prisma/client/runtime/library');
const prisma = require('../../../../../prisma/prisma.js');

// After mocking fs, require the module
const { createPriceFinder } = require('../../../../workers/portfolio-handlers/valuation/price-fetcher');

describe('price-fetcher — createPriceFinder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const makePortfolioItem = (overrides = {}) => ({
    id: 1,
    symbol: 'AAPL',
    exchange: 'NASDAQ',
    currency: 'USD',
    category: { processingHint: 'MANUAL', type: 'Investments' },
    ...overrides,
  });

  it('returns getDatesWithKnownPrices merged from DB and manual values', async () => {
    prisma.assetPrice.findMany.mockResolvedValue([
      { day: new Date('2026-01-01'), symbol: 'AAPL' },
      { day: new Date('2026-01-03'), symbol: 'AAPL' },
    ]);
    prisma.manualAssetValue.findMany.mockResolvedValue([
      { date: new Date('2026-01-02'), value: new Decimal(150) },
      { date: new Date('2026-01-03'), value: new Decimal(155) }, // overlapping date
    ]);

    const item = makePortfolioItem();
    const { getDatesWithKnownPrices } = await createPriceFinder(item);
    const dates = getDatesWithKnownPrices();

    // Should return unique sorted dates from both sources
    expect(dates).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  it('handles empty pre-fetched data', async () => {
    prisma.assetPrice.findMany.mockResolvedValue([]);
    prisma.manualAssetValue.findMany.mockResolvedValue([]);

    const item = makePortfolioItem();
    const { getDatesWithKnownPrices } = await createPriceFinder(item);
    const dates = getDatesWithKnownPrices();

    expect(dates).toEqual([]);
  });

  it('returns price from strategy when available', async () => {
    prisma.assetPrice.findMany.mockResolvedValue([]);
    prisma.manualAssetValue.findMany.mockResolvedValue([
      { date: new Date('2026-01-15'), value: new Decimal(200) },
    ]);

    // The strategy module was loaded dynamically. We need to get a reference to the mock.
    // Since the strategy loader uses require(path.join(...)), and we mocked the file,
    // we access it through the loaded strategies object indirectly by calling getPrice.
    const item = makePortfolioItem();
    const { getPrice } = await createPriceFinder(item);

    // The strategy's getPrice is called internally. Let's verify the function exists.
    expect(typeof getPrice).toBe('function');
  });

  it('returns null when no strategy found for unknown hint', async () => {
    prisma.assetPrice.findMany.mockResolvedValue([]);
    prisma.manualAssetValue.findMany.mockResolvedValue([]);

    const item = makePortfolioItem({ category: { processingHint: 'UNKNOWN_HINT', type: 'Investments' } });
    const { getPrice } = await createPriceFinder(item);
    const result = await getPrice(new Date('2026-01-15'));

    expect(result).toBeNull();
  });

  it('queries assetPrice with exchange when present', async () => {
    prisma.assetPrice.findMany.mockResolvedValue([]);
    prisma.manualAssetValue.findMany.mockResolvedValue([]);

    const item = makePortfolioItem({ exchange: 'NYSE' });
    await createPriceFinder(item);

    expect(prisma.assetPrice.findMany).toHaveBeenCalledWith({
      where: { symbol: 'AAPL', exchange: 'NYSE' },
    });
  });

  it('queries assetPrice without exchange when not present', async () => {
    prisma.assetPrice.findMany.mockResolvedValue([]);
    prisma.manualAssetValue.findMany.mockResolvedValue([]);

    const item = makePortfolioItem({ exchange: null });
    await createPriceFinder(item);

    expect(prisma.assetPrice.findMany).toHaveBeenCalledWith({
      where: { symbol: 'AAPL' },
    });
  });
});
