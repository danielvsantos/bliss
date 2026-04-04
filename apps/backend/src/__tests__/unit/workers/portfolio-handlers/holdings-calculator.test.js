jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../../prisma/prisma.js', () => ({
  transaction: { findMany: jest.fn() },
}));

jest.mock('../../../../utils/transactionNormalizer', () => ({
  normalizeTransaction: jest.fn((tx) => tx),
}));

const { Decimal } = require('@prisma/client/runtime/library');
const prisma = require('../../../../../prisma/prisma.js');
const { normalizeTransaction } = require('../../../../utils/transactionNormalizer');
const { createIncrementalHoldingsCalculator } = require('../../../../workers/portfolio-handlers/valuation/holdings-calculator');

describe('holdings-calculator — createIncrementalHoldingsCalculator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    normalizeTransaction.mockImplementation((tx) => tx);
  });

  const makeAsset = (overrides = {}) => ({
    id: 1,
    symbol: 'AAPL',
    currency: 'USD',
    category: { type: 'Investments' },
    ...overrides,
  });

  const makeTx = (overrides = {}) => ({
    id: 1,
    transaction_date: new Date('2026-01-15'),
    debit: null,
    credit: null,
    assetQuantity: null,
    assetPrice: null,
    currency: 'USD',
    ticker: 'AAPL',
    ...overrides,
  });

  it('calculates BUY transaction correctly (adds quantity and cost basis)', async () => {
    const buyTx = makeTx({
      id: 1,
      transaction_date: new Date('2026-01-15'),
      debit: new Decimal(1000),
      assetQuantity: new Decimal(10),
    });
    prisma.transaction.findMany.mockResolvedValue([buyTx]);

    const asset = makeAsset();
    const currencyRateCache = new Map();
    const { getHoldings } = await createIncrementalHoldingsCalculator('tenant-1', asset, currencyRateCache);

    const holdings = getHoldings(new Date('2026-01-15'));
    expect(holdings.quantity.toNumber()).toBe(10);
    expect(holdings.costBasis.toNumber()).toBe(1000);
  });

  it('calculates SELL transaction with average cost method', async () => {
    const buyTx = makeTx({
      id: 1,
      transaction_date: new Date('2026-01-10'),
      debit: new Decimal(1000),
      assetQuantity: new Decimal(10),
    });
    const sellTx = makeTx({
      id: 2,
      transaction_date: new Date('2026-01-20'),
      credit: new Decimal(600),
      assetQuantity: new Decimal(5),
    });
    prisma.transaction.findMany.mockResolvedValue([buyTx, sellTx]);

    const asset = makeAsset();
    const currencyRateCache = new Map();
    const { getHoldings } = await createIncrementalHoldingsCalculator('tenant-1', asset, currencyRateCache);

    const holdings = getHoldings(new Date('2026-01-20'));
    expect(holdings.quantity.toNumber()).toBe(5);
    // Average cost = 1000/10 = 100 per unit; sold 5 units => cost of goods sold = 500
    // Remaining cost basis = 1000 - 500 = 500
    expect(holdings.costBasis.toNumber()).toBe(500);
    // Realized PnL = proceeds (600) - cost of goods sold (500) = 100
    expect(holdings.realizedPnl.toNumber()).toBe(100);
  });

  it('returns running balance for Debt type items', async () => {
    const loanOrigination = makeTx({
      id: 1,
      transaction_date: new Date('2026-01-01'),
      credit: new Decimal(5000), // loan disbursement
      debit: null,
    });
    const payment = makeTx({
      id: 2,
      transaction_date: new Date('2026-02-01'),
      debit: new Decimal(500), // loan payment
      credit: null,
    });
    prisma.transaction.findMany.mockResolvedValue([loanOrigination, payment]);

    const asset = makeAsset({ category: { type: 'Debt' } });
    const currencyRateCache = new Map();
    const { getHoldings } = await createIncrementalHoldingsCalculator('tenant-1', asset, currencyRateCache);

    // After origination: balance = 5000 (credit - debit = 5000 - 0)
    const holdingsAfterOrigination = getHoldings(new Date('2026-01-01'));
    expect(holdingsAfterOrigination.quantity.toNumber()).toBe(1); // Debt is a single unit
    expect(holdingsAfterOrigination.costBasis.toNumber()).toBe(5000);

    // After payment: balance = 5000 - 500 = 4500
    const holdingsAfterPayment = getHoldings(new Date('2026-02-01'));
    expect(holdingsAfterPayment.costBasis.toNumber()).toBe(4500);
  });

  it('handles cross-currency conversions for cost basis', async () => {
    const buyTx = makeTx({
      id: 1,
      transaction_date: new Date('2026-01-15'),
      debit: new Decimal(1000),
      assetQuantity: new Decimal(10),
      currency: 'EUR', // transaction in EUR
    });
    prisma.transaction.findMany.mockResolvedValue([buyTx]);

    const asset = makeAsset({ currency: 'GBP' }); // asset denominated in GBP
    const currencyRateCache = new Map();
    // EUR to USD rate
    currencyRateCache.set('2026-01-15_EUR_USD', new Decimal(1.1));
    // GBP to USD rate
    currencyRateCache.set('2026-01-15_GBP_USD', new Decimal(1.3));

    const { getHoldings } = await createIncrementalHoldingsCalculator('tenant-1', asset, currencyRateCache);
    const holdings = getHoldings(new Date('2026-01-15'));

    expect(holdings.quantity.toNumber()).toBe(10);
    // Amount converted: 1000 * (EUR/USD) / (GBP/USD) = 1000 * 1.1 / 1.3 ~= 846.15
    const expectedCostBasis = 1000 * 1.1 / 1.3;
    expect(holdings.costBasis.toNumber()).toBeCloseTo(expectedCostBasis, 2);
  });

  it('returns getDatesWithTransactions in sorted order', async () => {
    const txs = [
      makeTx({ id: 1, transaction_date: new Date('2026-03-01'), debit: new Decimal(100), assetQuantity: new Decimal(1) }),
      makeTx({ id: 2, transaction_date: new Date('2026-01-01'), debit: new Decimal(200), assetQuantity: new Decimal(2) }),
      makeTx({ id: 3, transaction_date: new Date('2026-02-01'), debit: new Decimal(300), assetQuantity: new Decimal(3) }),
    ];
    prisma.transaction.findMany.mockResolvedValue(txs);

    const asset = makeAsset();
    const currencyRateCache = new Map();
    const { getDatesWithTransactions } = await createIncrementalHoldingsCalculator('tenant-1', asset, currencyRateCache);

    const dates = getDatesWithTransactions();
    expect(dates).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('returns zero holdings when no transactions exist', async () => {
    prisma.transaction.findMany.mockResolvedValue([]);

    const asset = makeAsset();
    const currencyRateCache = new Map();
    const { getHoldings, getDatesWithTransactions } = await createIncrementalHoldingsCalculator('tenant-1', asset, currencyRateCache);

    expect(getDatesWithTransactions()).toEqual([]);

    const holdings = getHoldings(new Date('2026-01-15'));
    expect(holdings.quantity.toNumber()).toBe(0);
    expect(holdings.costBasis.toNumber()).toBe(0);
    expect(holdings.realizedPnl.toNumber()).toBe(0);
  });

  it('forward-fills holdings to future dates after last transaction', async () => {
    const buyTx = makeTx({
      id: 1,
      transaction_date: new Date('2026-01-15'),
      debit: new Decimal(500),
      assetQuantity: new Decimal(5),
    });
    prisma.transaction.findMany.mockResolvedValue([buyTx]);

    const asset = makeAsset();
    const currencyRateCache = new Map();
    const { getHoldings } = await createIncrementalHoldingsCalculator('tenant-1', asset, currencyRateCache);

    // Holdings on a future date should carry forward from last transaction
    const holdings = getHoldings(new Date('2026-06-01'));
    expect(holdings.quantity.toNumber()).toBe(5);
    expect(holdings.costBasis.toNumber()).toBe(500);
  });

  it('tracks USD cost basis for non-USD assets', async () => {
    const buyTx = makeTx({
      id: 1,
      transaction_date: new Date('2026-01-15'),
      debit: new Decimal(1000),
      assetQuantity: new Decimal(10),
      currency: 'EUR',
    });
    prisma.transaction.findMany.mockResolvedValue([buyTx]);

    const asset = makeAsset({ currency: 'EUR' });
    const currencyRateCache = new Map();
    currencyRateCache.set('2026-01-15_EUR_USD', new Decimal(1.1));

    const { getHoldings } = await createIncrementalHoldingsCalculator('tenant-1', asset, currencyRateCache);
    const holdings = getHoldings(new Date('2026-01-15'));

    expect(holdings.costBasisInUSD.toNumber()).toBeCloseTo(1100, 2); // 1000 * 1.1
  });
});
