/**
 * Unit tests for cash-processor.js — the scoped-rebuild start date and the
 * pruning of cash items whose (currency, account) pair has no transactions
 * left. Both left stale cash balances behind after a transaction DELETE (#94).
 */

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../../prisma/prisma.js', () => ({
  transaction: { findFirst: jest.fn(), findMany: jest.fn() },
  portfolioItem: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  portfolioHolding: { findFirst: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  category: { findFirst: jest.fn() },
  incomeTerms: { findMany: jest.fn(), update: jest.fn() },
  debtTerms: { findMany: jest.fn(), update: jest.fn() },
  manualAssetValue: { findMany: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn((fn) => fn(jest.requireMock('../../../../../prisma/prisma.js'))),
}));

jest.mock('../../../../queues/eventsQueue', () => ({
  enqueueEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../../services/currencyService', () => ({
  getOrCreateCurrencyRate: jest.fn().mockResolvedValue(1),
}));

const prisma = require('../../../../../prisma/prisma.js');
const { enqueueEvent } = require('../../../../queues/eventsQueue');
const { processCashHoldings } = require('../../../../workers/portfolio-handlers/cash-processor');

const CASH_EUR = { id: 20, symbol: 'Cash EUR', currency: 'EUR', accountId: 5, categoryId: 1 };
const CASH_USD = { id: 21, symbol: 'Cash USD', currency: 'USD', accountId: 5, categoryId: 1 };

/** transaction.findMany serves both the distinct-pairs lookup and the per-year fetch. */
function mockTransactions({ pairs, rows = [] }) {
  prisma.transaction.findMany.mockImplementation(({ distinct }) =>
    Promise.resolve(distinct ? pairs : rows));
}

const holdingsDeleteWhere = () => prisma.portfolioHolding.deleteMany.mock.calls.map(([arg]) => arg.where);

beforeEach(() => {
  jest.clearAllMocks();
  prisma.transaction.findFirst.mockResolvedValue(null);
  prisma.transaction.findMany.mockResolvedValue([]);
  prisma.portfolioItem.findFirst.mockResolvedValue(CASH_EUR);
  prisma.portfolioItem.findMany.mockResolvedValue([]);
  prisma.portfolioItem.findUnique.mockResolvedValue({ currency: 'EUR' });
  prisma.portfolioItem.update.mockResolvedValue({});
  prisma.portfolioItem.deleteMany.mockResolvedValue({ count: 0 });
  prisma.portfolioHolding.findFirst.mockResolvedValue(null);
  prisma.portfolioHolding.createMany.mockResolvedValue({ count: 0 });
  prisma.portfolioHolding.deleteMany.mockResolvedValue({ count: 0 });
  prisma.incomeTerms.findMany.mockResolvedValue([]);
  prisma.debtTerms.findMany.mockResolvedValue([]);
  prisma.manualAssetValue.findMany.mockResolvedValue([]);
});

describe('cash-processor — scoped rebuild start date (#94)', () => {
  it('rebuilds from the start of the scope year when the deleted row was the earliest in scope', async () => {
    // The July −30 EUR row was deleted; the oldest remaining 2026 row is in August.
    mockTransactions({ pairs: [{ currency: 'EUR', accountId: 5 }] });
    prisma.portfolioItem.findMany.mockResolvedValue([CASH_EUR]);
    prisma.transaction.findFirst.mockResolvedValue({ transaction_date: new Date('2026-08-04T00:00:00Z') });

    await processCashHoldings('t1', { year: 2026, currency: 'EUR' });

    expect(holdingsDeleteWhere()).toContainEqual(expect.objectContaining({
      asset: expect.objectContaining({ currency: 'EUR', accountId: 5 }),
      date: { gte: new Date('2026-01-01T00:00:00Z') },
    }));
    expect(prisma.portfolioHolding.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ date: { lt: new Date('2026-01-01T00:00:00Z') } }),
    }));
  });

  it('keeps the oldest transaction as the start when it precedes the scope (fallback for later-starting pairs)', async () => {
    mockTransactions({ pairs: [{ currency: 'EUR', accountId: 5 }] });
    prisma.portfolioItem.findMany.mockResolvedValue([CASH_EUR]);
    prisma.transaction.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ transaction_date: new Date('2024-03-01T00:00:00Z') });

    await processCashHoldings('t1', { year: 2026, currency: 'EUR' });

    expect(holdingsDeleteWhere()).toContainEqual(expect.objectContaining({
      date: { gte: new Date('2024-03-01T00:00:00Z') },
    }));
  });

  it('rebuilds the whole pair when the scope has no date bound', async () => {
    mockTransactions({ pairs: [{ currency: 'EUR', accountId: 5 }] });
    prisma.portfolioItem.findMany.mockResolvedValue([CASH_EUR]);
    prisma.transaction.findFirst.mockResolvedValue({ transaction_date: new Date('2026-08-04T00:00:00Z') });

    await processCashHoldings('t1', { currency: 'EUR' });

    const where = holdingsDeleteWhere().find((w) => w.asset?.currency === 'EUR');
    expect(where).toBeDefined();
    expect(where.date).toBeUndefined();
    expect(prisma.portfolioHolding.findFirst).not.toHaveBeenCalled();
  });
});

describe('cash-processor — emptied (currency, account) pairs (#94)', () => {
  it('prunes a cash item whose pair has no transactions left, detaching its interest terms', async () => {
    mockTransactions({ pairs: [] });
    prisma.portfolioItem.findMany.mockResolvedValue([CASH_EUR]);
    prisma.incomeTerms.findMany.mockResolvedValue([{ id: 7, assetId: 20 }]);

    await processCashHoldings('t1', { year: 2026, currency: 'EUR' });

    expect(prisma.portfolioItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 't1', currency: 'EUR', category: { processingHint: 'CASH' } }),
    }));
    expect(prisma.incomeTerms.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({ assetId: null, orphanedLabel: 'Cash EUR' }),
    });
    expect(prisma.portfolioItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [20] } } });
    expect(enqueueEvent).toHaveBeenCalledWith('CASH_HOLDINGS_PROCESSED', expect.objectContaining({ tenantId: 't1' }));
  });

  it('keeps cash items whose pair still has transactions', async () => {
    mockTransactions({ pairs: [{ currency: 'EUR', accountId: 5 }] });
    prisma.portfolioItem.findMany.mockResolvedValue([CASH_EUR]);
    prisma.transaction.findFirst.mockResolvedValue({ transaction_date: new Date('2026-08-04T00:00:00Z') });

    await processCashHoldings('t1', { year: 2026, currency: 'EUR' });

    expect(prisma.portfolioItem.deleteMany).not.toHaveBeenCalled();
  });

  it('prunes emptied cash items on a full rebuild too (deleting every transaction leaves no cash series)', async () => {
    mockTransactions({ pairs: [{ currency: 'EUR', accountId: 5 }] });
    prisma.portfolioItem.findMany.mockResolvedValue([CASH_EUR, CASH_USD]);

    await processCashHoldings('t1', {});

    expect(prisma.portfolioItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ accountId: { not: null } }),
    }));
    expect(prisma.portfolioItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [21] } } });
  });
});
