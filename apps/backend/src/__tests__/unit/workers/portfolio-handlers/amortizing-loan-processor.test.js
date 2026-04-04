jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../../prisma/prisma.js', () => ({
  debtTerms: { findUnique: jest.fn(), findMany: jest.fn() },
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
const processAmortizingLoan = require('../../../../workers/portfolio-handlers/amortizing-loan-processor');

describe('amortizing-loan-processor — processAmortizingLoan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.portfolioHolding.createMany.mockResolvedValue({ count: 0 });
    prisma.portfolioItem.update.mockResolvedValue({});
    prisma.debtTerms.findMany.mockResolvedValue([]);
    prisma.transaction.findFirst.mockResolvedValue(null);
    getRatesForDateRange.mockResolvedValue(new Map());
  });

  const makeJob = (debts, tenantId = 'tenant-1') => ({
    id: 'job-1',
    name: 'process-amortizing-loan',
    data: { tenantId, debts },
  });

  it('uses DebtTerms initial balance when available', async () => {
    const debts = [{ id: 1, symbol: 'Mortgage', currency: 'USD' }];
    const originationDate = new Date('2026-01-01');

    prisma.debtTerms.findUnique.mockResolvedValue({
      assetId: 1,
      initialBalance: new Decimal(200000),
      originationDate: originationDate,
    });

    // Principal payments
    prisma.transaction.findMany.mockResolvedValue([
      { id: 1, transaction_date: new Date('2026-01-02'), debit: new Decimal(1000), credit: null },
    ]);

    const job = makeJob(debts);
    const result = await processAmortizingLoan(job);

    expect(result).toEqual({ success: true });
    expect(prisma.portfolioItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          costBasis: new Decimal(200000),
          currentValue: expect.any(Decimal),
        }),
      })
    );

    // Final balance should be initial - payments = 200000 - 1000 = 199000
    const updateData = prisma.portfolioItem.update.mock.calls[0][0].data;
    expect(updateData.currentValue.toNumber()).toBe(-199000); // Negated for liability
  });

  it('falls back to origination transaction when no DebtTerms', async () => {
    const debts = [{ id: 1, symbol: 'Car Loan', currency: 'USD' }];

    prisma.debtTerms.findUnique.mockResolvedValue(null);

    // For USD debts, currenciesToFetch is empty so findFirst is NOT called for rate pre-fetch.
    // The only findFirst call is the origination transaction fallback inside the per-debt loop.
    prisma.transaction.findFirst.mockResolvedValue({
      id: 1,
      transaction_date: new Date('2026-01-01'),
      credit: new Decimal(30000),
    });

    prisma.transaction.findMany.mockResolvedValue([]);

    const job = makeJob(debts);
    await processAmortizingLoan(job);

    expect(prisma.portfolioItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costBasis: new Decimal(30000),
        }),
      })
    );
  });

  it('accumulates payments by date and reduces balance', async () => {
    const debts = [{ id: 1, symbol: 'Student Loan', currency: 'USD' }];

    prisma.debtTerms.findUnique.mockResolvedValue({
      assetId: 1,
      initialBalance: new Decimal(10000),
      originationDate: new Date('2026-01-01'),
    });

    // Two payments on same day + one on another day
    prisma.transaction.findMany.mockResolvedValue([
      { id: 1, transaction_date: new Date('2026-01-02'), debit: new Decimal(500), credit: null },
      { id: 2, transaction_date: new Date('2026-01-02'), debit: new Decimal(300), credit: null },
      { id: 3, transaction_date: new Date('2026-01-03'), debit: new Decimal(200), credit: null },
    ]);

    const job = makeJob(debts);
    await processAmortizingLoan(job);

    // Final balance = 10000 - 500 - 300 - 200 = 9000
    const updateData = prisma.portfolioItem.update.mock.calls[0][0].data;
    expect(updateData.currentValue.toNumber()).toBe(-9000);
  });

  it('handles currency conversion for non-USD debts', async () => {
    const debts = [{ id: 1, symbol: 'EUR Mortgage', currency: 'EUR' }];
    const originationDate = new Date('2026-01-01');

    prisma.debtTerms.findUnique.mockResolvedValue({
      assetId: 1,
      initialBalance: new Decimal(100000),
      originationDate: originationDate,
    });

    prisma.debtTerms.findMany.mockResolvedValue([{
      assetId: 1,
      originationDate: originationDate,
    }]);

    prisma.transaction.findFirst.mockResolvedValue({
      transaction_date: originationDate,
    });

    const ratesMap = new Map([
      ['2026-01-01', new Decimal(1.1)],
      ['2026-01-02', new Decimal(1.12)],
    ]);
    getRatesForDateRange.mockResolvedValue(ratesMap);

    prisma.transaction.findMany.mockResolvedValue([
      { id: 1, transaction_date: new Date('2026-01-02'), debit: new Decimal(1000), credit: null },
    ]);

    const job = makeJob(debts);
    await processAmortizingLoan(job);

    expect(getRatesForDateRange).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      'EUR',
      'USD'
    );

    const updateData = prisma.portfolioItem.update.mock.calls[0][0].data;
    // Initial USD = 100000 * 1.1 = 110000
    expect(updateData.costBasisInUSD.toNumber()).toBeCloseTo(110000, 0);
  });

  it('skips debt when no DebtTerms and no origination transaction found', async () => {
    const debts = [{ id: 1, symbol: 'Mystery Debt', currency: 'USD' }];

    prisma.debtTerms.findUnique.mockResolvedValue(null);
    prisma.transaction.findFirst.mockResolvedValue(null);
    prisma.transaction.findMany.mockResolvedValue([]);

    const job = makeJob(debts);
    const result = await processAmortizingLoan(job);

    expect(result).toEqual({ success: true });
    expect(prisma.portfolioHolding.createMany).not.toHaveBeenCalled();
    expect(prisma.portfolioItem.update).not.toHaveBeenCalled();
  });

  it('stores holdings as negative values (liabilities)', async () => {
    const debts = [{ id: 1, symbol: 'Loan', currency: 'USD' }];

    prisma.debtTerms.findUnique.mockResolvedValue({
      assetId: 1,
      initialBalance: new Decimal(5000),
      originationDate: new Date('2026-01-01'),
    });
    prisma.transaction.findMany.mockResolvedValue([]);

    const job = makeJob(debts);
    await processAmortizingLoan(job);

    const createCall = prisma.portfolioHolding.createMany.mock.calls[0][0];
    // All totalValue entries should be negative
    for (const record of createCall.data) {
      expect(record.totalValue.isNegative()).toBe(true);
    }
  });
});
