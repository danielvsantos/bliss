import { describe, it, expect } from 'vitest';
import { diffTransactionUpdate } from '../../../utils/transactionDiff.js';

const existing = {
  transaction_date: new Date('2026-03-04T00:00:00.000Z'),
  year: 2026,
  quarter: 'Q1',
  month: 3,
  day: 4,
  categoryId: 10,
  accountId: 20,
  description: 'Coffee',
  details: null,
  // Prisma returns Decimal(18,8) columns as Decimal objects; toString is what matters.
  credit: null,
  debit: { toString: () => '2003.76000000' },
  currency: 'EUR',
  assetQuantity: null,
  assetPrice: null,
  ticker: null,
  isin: null,
  exchange: null,
  assetCurrency: null,
  portfolioItemId: null,
  userId: 'someone@else.test',
  tags: [{ tagId: 1 }, { tagId: 2 }],
};

// What PUT builds when the form (or update_transaction) resends the current values.
const resend = () => ({
  userId: 'me@test',
  transaction_date: new Date('2026-03-04T00:00:00.000Z'),
  year: 2026,
  quarter: 'Q1',
  month: 3,
  day: 4,
  categoryId: 10,
  accountId: 20,
  description: 'Coffee',
  details: '',
  credit: null,
  debit: 2003.76,
  currency: 'EUR',
  assetQuantity: null,
  assetPrice: null,
  ticker: undefined,
  isin: null,
  exchange: null,
  assetCurrency: null,
  portfolioItemId: undefined,
});

describe('diffTransactionUpdate (#141)', () => {
  it('is empty when every written value matches', () => {
    expect(diffTransactionUpdate(existing, resend())).toEqual([]);
  });

  it('ignores the audit userId and skips undefined (unwritten) fields', () => {
    expect(diffTransactionUpdate(existing, { ...resend(), userId: 'other', ticker: undefined })).toEqual([]);
  });

  it('treats null, undefined and empty string alike for optional text', () => {
    expect(diffTransactionUpdate(existing, { ...resend(), details: null, isin: '' })).toEqual([]);
  });

  it.each([
    ['categoryId', 11],
    ['accountId', 21],
    ['description', 'Coffee shop'],
    ['details', 'note'],
    ['currency', 'USD'],
    ['ticker', 'AAPL'],
    ['exchange', 'XETR'],
    ['isin', 'US0378331005'],
    ['assetCurrency', 'USD'],
    ['portfolioItemId', 5],
    ['assetQuantity', 1],
    ['assetPrice', 2],
    ['credit', 2003.76],
    ['day', 5],
  ])('reports a change to %s', (field, value) => {
    expect(diffTransactionUpdate(existing, { ...resend(), [field]: value })).toContain(field);
  });

  it('compares dates by instant', () => {
    expect(diffTransactionUpdate(existing, { ...resend(), transaction_date: new Date('2026-03-05T00:00:00Z') }))
      .toEqual(['transaction_date']);
  });

  it('compares decimals at 8-dp precision', () => {
    expect(diffTransactionUpdate(existing, { ...resend(), debit: 2003.760000001 })).toEqual([]);
    expect(diffTransactionUpdate(existing, { ...resend(), debit: 2003.77 })).toEqual(['debit']);
  });

  it('compares tags as a set, only when tags were sent', () => {
    expect(diffTransactionUpdate(existing, resend(), { tagIds: [2, 1] })).toEqual([]);
    expect(diffTransactionUpdate(existing, resend(), { tagIds: [1] })).toEqual(['tags']);
    expect(diffTransactionUpdate(existing, resend(), { tagIds: [1, 2, 3] })).toEqual(['tags']);
    expect(diffTransactionUpdate(existing, resend(), { tagIds: [] })).toEqual(['tags']);
    expect(diffTransactionUpdate({ ...existing, tags: [] }, resend(), { tagIds: [] })).toEqual([]);
  });
});
