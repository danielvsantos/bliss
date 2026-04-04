jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../../prisma/prisma.js', () => ({
  transaction: { findMany: jest.fn(), findFirst: jest.fn() },
  portfolioHolding: { createMany: jest.fn() },
  portfolioItem: { update: jest.fn() },
}));

jest.mock('../../../../services/currencyService', () => ({
  getRatesForDateRange: jest.fn(),
}));

const { Decimal } = require('@prisma/client/runtime/library');
const prisma = require('../../../../../prisma/prisma.js');
const { getRatesForDateRange } = require('../../../../services/currencyService');
const processSimpleLiability = require('../../../../workers/portfolio-handlers/simple-liability-processor');

describe('simple-liability-processor — processSimpleLiability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.portfolioHolding.createMany.mockResolvedValue({ count: 0 });
    prisma.portfolioItem.update.mockResolvedValue({});
  });

  const makeJob = (debts, tenantId = 'tenant-1') => ({
    id: 'job-1',
    name: 'process-simple-liability',
    data: { tenantId, debts },
  });

  it('creates negative holdings for debt items', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const originationDate = new Date(today);
    originationDate.setDate(originationDate.getDate() - 2);

    const debts = [{ id: 1, symbol: 'Personal Loan', currency: 'USD' }];

    // First call: findFirst for earliest transaction (currency rate pre-fetch)
    prisma.transaction.findFirst.mockResolvedValue(null);

    // findMany for all transactions for the debt
    prisma.transaction.findMany.mockResolvedValue([
      {
        id: 1,
        transaction_date: originationDate,
        credit: new Decimal(10000),
        debit: null,
      },
    ]);

    const job = makeJob(debts);
    const result = await processSimpleLiability(job);

    expect(result).toEqual({ success: true });
    expect(prisma.portfolioHolding.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            portfolioItemId: 1,
            totalValue: expect.any(Decimal), // Should be negative
          }),
        ]),
      })
    );

    // Verify the totalValue is negative (debt is stored as negative)
    const createCall = prisma.portfolioHolding.createMany.mock.calls[0][0];
    const firstRecord = createCall.data[0];
    expect(firstRecord.totalValue.isNegative()).toBe(true);
  });

  it('deducts payments correctly', async () => {
    const originationDate = new Date('2026-01-01');
    const paymentDate = new Date('2026-01-02');

    const debts = [{ id: 1, symbol: 'Car Loan', currency: 'USD' }];

    prisma.transaction.findFirst.mockResolvedValue(null);
    prisma.transaction.findMany.mockResolvedValue([
      { id: 1, transaction_date: originationDate, credit: new Decimal(5000), debit: null },
      { id: 2, transaction_date: paymentDate, debit: new Decimal(1000), credit: null },
    ]);

    const job = makeJob(debts);
    await processSimpleLiability(job);

    // Verify the portfolioItem update reflects the reduced balance
    expect(prisma.portfolioItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          currentValue: expect.any(Decimal), // Should be -(5000-1000) = -4000
        }),
      })
    );
    const updateData = prisma.portfolioItem.update.mock.calls[0][0].data;
    expect(updateData.currentValue.toNumber()).toBe(-4000);
  });

  it('handles currency conversion for non-USD debts', async () => {
    const originationDate = new Date('2026-01-01');
    const debts = [{ id: 1, symbol: 'EUR Loan', currency: 'EUR' }];

    // Pre-fetch: findFirst returns a transaction for rate fetching
    prisma.transaction.findFirst.mockResolvedValue({
      transaction_date: originationDate,
    });

    const ratesMap = new Map([['2026-01-01', new Decimal(1.1)]]);
    getRatesForDateRange.mockResolvedValue(ratesMap);

    prisma.transaction.findMany.mockResolvedValue([
      { id: 1, transaction_date: originationDate, credit: new Decimal(5000), debit: null },
    ]);

    const job = makeJob(debts);
    await processSimpleLiability(job);

    expect(getRatesForDateRange).toHaveBeenCalledWith(
      originationDate,
      expect.any(Date),
      'EUR',
      'USD'
    );

    // The USD values should be converted
    const updateData = prisma.portfolioItem.update.mock.calls[0][0].data;
    expect(updateData.costBasisInUSD.toNumber()).toBeCloseTo(5500, 0); // 5000 * 1.1
  });

  it('skips items with no origination (credit) transaction', async () => {
    const debts = [{ id: 1, symbol: 'Empty Debt', currency: 'USD' }];

    prisma.transaction.findFirst.mockResolvedValue(null);
    prisma.transaction.findMany.mockResolvedValue([
      // Only payments, no origination credit
      { id: 1, transaction_date: new Date('2026-01-01'), debit: new Decimal(100), credit: null },
    ]);

    const job = makeJob(debts);
    const result = await processSimpleLiability(job);

    expect(result).toEqual({ success: true });
    expect(prisma.portfolioHolding.createMany).not.toHaveBeenCalled();
    expect(prisma.portfolioItem.update).not.toHaveBeenCalled();
  });

  it('handles multiple debts in a single job', async () => {
    const debts = [
      { id: 1, symbol: 'Loan A', currency: 'USD' },
      { id: 2, symbol: 'Loan B', currency: 'USD' },
    ];

    prisma.transaction.findFirst.mockResolvedValue(null);
    prisma.transaction.findMany
      .mockResolvedValueOnce([
        { id: 1, transaction_date: new Date('2026-01-01'), credit: new Decimal(3000), debit: null },
      ])
      .mockResolvedValueOnce([
        { id: 2, transaction_date: new Date('2026-01-01'), credit: new Decimal(7000), debit: null },
      ]);

    const job = makeJob(debts);
    const result = await processSimpleLiability(job);

    expect(result).toEqual({ success: true });
    expect(prisma.portfolioHolding.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.portfolioItem.update).toHaveBeenCalledTimes(2);
  });
});
