/**
 * Unit tests for eToro copy trade valuation (#143): the COPY_TRADING pricing
 * strategy, the price fetcher's copy value map, and the copy value currency
 * conversion. The DB end-to-end path is covered by
 * __tests__/integration/etoroSync.test.js.
 */
jest.mock('../../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../../../prisma/prisma.js', () => ({
  assetPrice: { findMany: jest.fn() },
  manualAssetValue: { findMany: jest.fn() },
  etoroCopy: { findMany: jest.fn() },
  etoroCopyValue: { findMany: jest.fn() },
}));
jest.mock('../../../../services/currencyService', () => ({
  getOrCreateCurrencyRate: jest.fn(),
  getRatesForDateRange: jest.fn(),
}));

const { Decimal } = require('@prisma/client/runtime/library');
const prisma = require('../../../../../prisma/prisma.js');
const COPY_TRADING = require('../../../../workers/portfolio-handlers/valuation/strategies/COPY_TRADING');
const { createPriceFinder, loadCopyValueMap } = require('../../../../workers/portfolio-handlers/valuation/price-fetcher');
const { convertCopyValue } = require('../../../../workers/portfolio-handlers/valuation');

const d = (s) => new Date(`${s}T00:00:00Z`);
const ITEM = { id: 7, tenantId: 't1', accountId: 3, symbol: 'TopInvestor', category: { processingHint: 'COPY_TRADING' } };

const caches = ({ manual = {}, copy = {} } = {}) => ({
  manualValueMap: new Map(Object.entries(manual).map(([k, v]) => [k, { value: new Decimal(v) }])),
  copyValueMap: new Map(Object.entries(copy).map(([k, v]) => [k, { value: new Decimal(v), currency: 'USD' }])),
  forwardPriceCache: new Map(),
  dbPriceMap: new Map(),
});

describe('COPY_TRADING strategy', () => {
  it('returns eToro\'s total on an eToro day and carries it forward after', async () => {
    const c = caches({ copy: { '2026-10-20': 1200, '2026-10-22': 1300 } });
    await expect(COPY_TRADING.getPrice(ITEM, d('2026-10-20'), c))
      .resolves.toEqual({ totalValue: new Decimal(1200), totalValueCurrency: 'USD', source: 'ETORO' });
    await expect(COPY_TRADING.getPrice(ITEM, d('2026-10-21'), c))
      .resolves.toMatchObject({ totalValue: new Decimal(1200), source: 'ETORO:FORWARD' });
    await expect(COPY_TRADING.getPrice(ITEM, d('2026-12-31'), c))
      .resolves.toMatchObject({ totalValue: new Decimal(1300), source: 'ETORO:FORWARD' });
  });

  it('behaves like MANUAL before the first eToro day (history before the connection never changes)', async () => {
    const c = caches({ manual: { '2026-03-01': 1100 }, copy: { '2026-10-20': 1200 } });
    await expect(COPY_TRADING.getPrice(ITEM, d('2026-02-01'), c)).resolves.toBeNull();
    await expect(COPY_TRADING.getPrice(ITEM, d('2026-05-01'), c))
      .resolves.toEqual({ price: new Decimal(1100), source: 'Manual:ForwardFill' });
  });

  it('a manual value on the exact day wins over eToro (R11), but not a forward-filled one', async () => {
    const c = caches({ manual: { '2026-10-21': 1500, '2026-10-01': 900 }, copy: { '2026-10-20': 1200 } });
    await expect(COPY_TRADING.getPrice(ITEM, d('2026-10-21'), c)).resolves.toEqual({ price: new Decimal(1500), source: 'Manual' });
    await expect(COPY_TRADING.getPrice(ITEM, d('2026-10-25'), c)).resolves.toMatchObject({ source: 'ETORO:FORWARD' });
  });

  it('is plain MANUAL for an unlinked holding', async () => {
    await expect(COPY_TRADING.getPrice(ITEM, d('2026-10-21'), caches({ manual: { '2026-10-01': 900 } })))
      .resolves.toEqual({ price: new Decimal(900), source: 'Manual:ForwardFill' });
  });
});

describe('price fetcher for a Copy Trading holding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.manualAssetValue.findMany.mockResolvedValue([]);
  });

  it('never reads AssetPrice and resolves copies by tenant, account and lower-cased username', async () => {
    prisma.etoroCopy.findMany.mockResolvedValue([{ id: 'c1', startedAt: d('2026-01-01'), createdAt: d('2026-10-20') }]);
    prisma.etoroCopyValue.findMany.mockResolvedValue([{ copyId: 'c1', day: d('2026-10-20'), value: new Decimal(1200), currency: 'USD' }]);
    const finder = await createPriceFinder(ITEM);
    expect(prisma.assetPrice.findMany).not.toHaveBeenCalled();
    expect(prisma.etoroCopy.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 't1', parentUsername: 'topinvestor', connection: { accountId: 3 } },
    }));
    await expect(finder.getPrice(d('2026-10-20'))).resolves.toMatchObject({ source: 'ETORO' });
    expect(finder.getDatesWithKnownPrices()).toEqual([]);
  });

  it('prefers the newest copy when a restarted copy shares a day with the old one', async () => {
    prisma.etoroCopy.findMany.mockResolvedValue([
      { id: 'old', startedAt: d('2025-01-01'), createdAt: d('2026-10-01') },
      { id: 'new', startedAt: d('2026-10-15'), createdAt: d('2026-10-15') },
    ]);
    prisma.etoroCopyValue.findMany.mockResolvedValue([
      { copyId: 'old', day: d('2026-10-14'), value: new Decimal(500), currency: 'USD' },
      { copyId: 'new', day: d('2026-10-15'), value: new Decimal(1000), currency: 'USD' },
      { copyId: 'old', day: d('2026-10-15'), value: new Decimal(10), currency: 'USD' },
    ]);
    const map = await loadCopyValueMap(ITEM);
    expect(Number(map.get('2026-10-14').value)).toBe(500);
    expect(Number(map.get('2026-10-15').value)).toBe(1000);
  });

  it('a holding without an account links to nothing', async () => {
    await expect(loadCopyValueMap({ ...ITEM, accountId: null })).resolves.toEqual(new Map());
    expect(prisma.etoroCopy.findMany).not.toHaveBeenCalled();
  });
});

describe('convertCopyValue', () => {
  const rates = { EUR: 1.1, GBP: 1.25 }; // currency → USD
  const getRate = jest.fn(async (_d, from) => rates[from] ?? null);

  it('keeps USD as is', async () => {
    const r = await convertCopyValue({ totalValue: 1000, totalValueCurrency: 'USD' }, d('2026-10-20'), 'USD', getRate);
    expect([Number(r.native), Number(r.usd)]).toEqual([1000, 1000]);
  });

  it('converts a USD copy value to a EUR holding through USD', async () => {
    const r = await convertCopyValue({ totalValue: 1100, totalValueCurrency: 'USD' }, d('2026-10-20'), 'EUR', getRate);
    expect(Number(r.native)).toBeCloseTo(1000);
    expect(Number(r.usd)).toBe(1100);
  });

  it('converts a GBP account value to a EUR holding (cross rate via USD)', async () => {
    const r = await convertCopyValue({ totalValue: 100, totalValueCurrency: 'GBP' }, d('2026-10-20'), 'EUR', getRate);
    expect(Number(r.usd)).toBeCloseTo(125);
    expect(Number(r.native)).toBeCloseTo(125 / 1.1);
  });

  it('returns null when a rate is missing', async () => {
    await expect(convertCopyValue({ totalValue: 1, totalValueCurrency: 'USD' }, d('2026-10-20'), 'BRL', getRate)).resolves.toBeNull();
    await expect(convertCopyValue({ totalValue: 1, totalValueCurrency: 'CHF' }, d('2026-10-20'), 'USD', getRate)).resolves.toBeNull();
  });
});
