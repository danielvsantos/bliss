jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../prisma/prisma.js', () => ({}));

const { Decimal } = require('@prisma/client/runtime/library');

const { getPrice } = require('../../../workers/portfolio-handlers/valuation/strategies/MANUAL');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makePortfolioItem = (overrides = {}) => ({
  symbol: 'MY_HOUSE',
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

describe('MANUAL strategy — getPrice()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns exact manual value when date matches', async () => {
    const manualValueMap = new Map([
      ['2026-03-02', { value: new Decimal(500000.00) }],
    ]);
    const caches = makePriceCaches({ manualValueMap });

    const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

    expect(result).toEqual({ price: new Decimal(500000.00), source: 'Manual' });
  });

  it('returns most recent prior manual value as forward-fill', async () => {
    const manualValueMap = new Map([
      ['2026-02-15', { value: new Decimal(480000.00) }],
      ['2026-01-01', { value: new Decimal(460000.00) }],
    ]);
    const caches = makePriceCaches({ manualValueMap });

    const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

    expect(result).toEqual({ price: new Decimal(480000.00), source: 'Manual:ForwardFill' });
  });

  it('populates forwardPriceCache for forward-fill result', async () => {
    const manualValueMap = new Map([
      ['2026-02-15', { value: new Decimal(480000.00) }],
    ]);
    const caches = makePriceCaches({ manualValueMap });

    await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

    expect(caches.forwardPriceCache.get('2026-03-02')).toEqual({
      price: new Decimal(480000.00),
      source: 'Manual:ForwardFill',
    });
  });

  it('returns null when no manual values exist', async () => {
    const caches = makePriceCaches();

    const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

    expect(result).toBeNull();
  });

  it('does NOT return future manual values', async () => {
    const manualValueMap = new Map([
      ['2026-04-01', { value: new Decimal(520000.00) }],
    ]);
    const caches = makePriceCaches({ manualValueMap });

    const result = await getPrice(makePortfolioItem(), new Date('2026-03-02'), caches);

    expect(result).toBeNull();
  });
});
