/**
 * Unit tests for income-terms-preserver.js (Passive Income #77, R7.5):
 * income terms of a re-keyed portfolio item are moved to a single clear
 * replacement or detached — never silently deleted.
 */
jest.mock('../../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  preserveTermsBeforePrune,
  pruneItemsPreservingTerms,
} = require('../../../../workers/portfolio-handlers/income-terms-preserver');

function makeTx({ income = [], debt = [] } = {}) {
  return {
    incomeTerms: { findMany: jest.fn().mockResolvedValue(income), update: jest.fn().mockResolvedValue({}) },
    debtTerms: { findMany: jest.fn().mockResolvedValue(debt), update: jest.fn().mockResolvedValue({}) },
    portfolioItem: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
}

const orphan = { id: 1, symbol: 'Bonds - Old', accountId: 5, categoryId: 20 };

describe('preserveTermsBeforePrune', () => {
  it('is a no-op with no orphans', async () => {
    const tx = makeTx();
    await expect(preserveTermsBeforePrune(tx, [], [])).resolves.toEqual({ moved: 0, detached: 0 });
    expect(tx.incomeTerms.findMany).not.toHaveBeenCalled();
  });

  it('is a no-op when no orphan owns terms', async () => {
    const tx = makeTx();
    await expect(preserveTermsBeforePrune(tx, [orphan], [])).resolves.toEqual({ moved: 0, detached: 0 });
    expect(tx.incomeTerms.update).not.toHaveBeenCalled();
  });

  it('moves income AND debt terms to a single candidate matched by symbol (account corrected)', async () => {
    const tx = makeTx({ income: [{ id: 50, assetId: 1 }], debt: [{ id: 60, assetId: 1 }] });
    const res = await preserveTermsBeforePrune(tx, [orphan], [
      { id: 2, symbol: 'Bonds - Old', accountId: 6, categoryId: 20 },
    ]);
    expect(res).toEqual({ moved: 1, detached: 0 });
    expect(tx.incomeTerms.update).toHaveBeenCalledWith({ where: { id: 50 }, data: { assetId: 2 } });
    expect(tx.debtTerms.update).toHaveBeenCalledWith({ where: { id: 60 }, data: { assetId: 2 } });
  });

  it('detaches when two candidates match', async () => {
    const tx = makeTx({ income: [{ id: 50, assetId: 1 }] });
    const res = await preserveTermsBeforePrune(tx, [orphan], [
      { id: 2, symbol: 'Bonds - A', accountId: 5, categoryId: 20 },
      { id: 3, symbol: 'Bonds - B', accountId: 5, categoryId: 20 },
    ]);
    expect(res).toEqual({ moved: 0, detached: 1 });
    expect(tx.incomeTerms.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { assetId: null, orphanedAt: expect.any(Date), orphanedLabel: 'Bonds - Old' },
    });
  });

  it('detaches both orphans when they claim the same single candidate', async () => {
    const tx = makeTx({ income: [{ id: 50, assetId: 1 }, { id: 51, assetId: 4 }] });
    const res = await preserveTermsBeforePrune(
      tx,
      [orphan, { id: 4, symbol: 'Bonds - Other', accountId: 5, categoryId: 20 }],
      [{ id: 2, symbol: 'Bonds - New', accountId: 5, categoryId: 20 }],
    );
    expect(res).toEqual({ moved: 0, detached: 2 });
  });

  it('ignores candidates in a different category', async () => {
    const tx = makeTx({ income: [{ id: 50, assetId: 1 }] });
    const res = await preserveTermsBeforePrune(tx, [orphan], [
      { id: 2, symbol: 'Bonds - Old', accountId: 5, categoryId: 99 },
    ]);
    expect(res).toEqual({ moved: 0, detached: 1 });
  });

  it('leaves unmatched DebtTerms alone (deleted by cascade, unchanged behaviour)', async () => {
    const tx = makeTx({ debt: [{ id: 60, assetId: 1 }] });
    const res = await preserveTermsBeforePrune(tx, [orphan], []);
    expect(res).toEqual({ moved: 0, detached: 0 });
    expect(tx.debtTerms.update).not.toHaveBeenCalled();
  });
});

describe('pruneItemsPreservingTerms', () => {
  it('runs preserve + delete inside one interactive transaction', async () => {
    const tx = makeTx({ income: [{ id: 50, assetId: 1 }] });
    const prisma = { $transaction: jest.fn((fn) => fn(tx)) };
    const res = await pruneItemsPreservingTerms(prisma, [orphan], []);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.portfolioItem.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1] } } });
    expect(res).toEqual({ moved: 0, detached: 1, deleted: 1 });
  });

  it('skips the transaction entirely with nothing to prune', async () => {
    const prisma = { $transaction: jest.fn() };
    await expect(pruneItemsPreservingTerms(prisma, [], [])).resolves.toEqual({ moved: 0, detached: 0, deleted: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
