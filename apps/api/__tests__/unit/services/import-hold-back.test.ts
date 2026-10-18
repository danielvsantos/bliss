/**
 * Unit tests for the Smart Import hold-back contract (#142) —
 * `@bliss/shared/import` and `missingInvestmentFields()` from
 * `@bliss/shared/portfolio`. `packages/shared` has no test runner, so it's
 * tested here against the ESM build, like the activity module.
 */
import { describe, it, expect } from 'vitest';
import {
  HOLD_BACK_PREFIX,
  HOLD_BACK_REASONS,
  formatHoldBack,
  parseHoldBack,
  summarizeHeldBack,
} from '@bliss/shared/import';
import { missingInvestmentFields, isInvestmentEnrichmentComplete } from '@bliss/shared/portfolio';

describe('formatHoldBack / parseHoldBack', () => {
  it('formats in canonical order, de-duplicated, and round-trips', () => {
    const msg = formatHoldBack(['MISSING_ACCOUNT', 'MISSING_PRICE', 'MISSING_PRICE', 'MISSING_QUANTITY']);
    expect(msg).toBe('HELD_BACK:MISSING_QUANTITY,MISSING_PRICE,MISSING_ACCOUNT');
    expect(parseHoldBack(msg)).toEqual(['MISSING_QUANTITY', 'MISSING_PRICE', 'MISSING_ACCOUNT']);
  });

  it('throws on unknown or empty codes', () => {
    expect(() => formatHoldBack(['NOPE'])).toThrow(/Unknown hold-back reason/);
    expect(() => formatHoldBack([])).toThrow();
  });

  it('returns null for staging text and null; drops unknown codes', () => {
    expect(parseHoldBack(null)).toBeNull();
    expect(parseHoldBack('Missing or invalid date')).toBeNull();
    expect(parseHoldBack('Could not resolve account from CSV value')).toBeNull();
    expect(parseHoldBack(`${HOLD_BACK_PREFIX}FUTURE_CODE,DUPLICATE`)).toEqual(['DUPLICATE']);
    expect(parseHoldBack(`${HOLD_BACK_PREFIX}FUTURE_CODE`)).toBeNull();
  });

  it('lists the seven reasons', () => {
    expect(HOLD_BACK_REASONS).toEqual([
      'MISSING_TICKER', 'MISSING_QUANTITY', 'MISSING_PRICE', 'MISSING_ACCOUNT',
      'DUPLICATE', 'UPDATE_FAILED', 'COMMIT_ERROR',
    ]);
  });
});

describe('summarizeHeldBack', () => {
  it('counts rows in total and codes in byReason', () => {
    expect(summarizeHeldBack([
      ['MISSING_QUANTITY', 'MISSING_PRICE'],
      ['MISSING_PRICE'],
      ['DUPLICATE'],
      [],
    ])).toEqual({ total: 3, byReason: { MISSING_QUANTITY: 1, MISSING_PRICE: 2, DUPLICATE: 1 } });
  });

  it('is empty for no rows', () => {
    expect(summarizeHeldBack([])).toEqual({ total: 0, byReason: {} });
  });
});

describe('missingInvestmentFields', () => {
  const stocks = { type: 'Investments', processingHint: 'API_STOCK' };
  const funds = { type: 'Investments', processingHint: 'API_FUND', defaultCategoryCode: 'INVESTMENT_FUNDS' };
  const etfs = { type: 'Investments', processingHint: 'API_FUND', defaultCategoryCode: 'INVESTMENT_ETFS' };
  const groceries = { type: 'Essentials', processingHint: null };

  it('names every missing field in ticker, quantity, price order', () => {
    expect(missingInvestmentFields(stocks, { ticker: null, assetQuantity: null, assetPrice: '' }))
      .toEqual(['ticker', 'quantity', 'price']);
    expect(missingInvestmentFields(stocks, { ticker: 'AAPL', assetQuantity: 0, assetPrice: null }))
      .toEqual(['price']);
  });

  it('treats a numeric placeholder ticker as missing', () => {
    expect(missingInvestmentFields(stocks, { ticker: '0', assetQuantity: 1, assetPrice: 1 })).toEqual(['ticker']);
  });

  it('does not require a ticker in the built-in Funds category, but does for ETFs', () => {
    expect(missingInvestmentFields(funds, { ticker: null, assetQuantity: 1, assetPrice: 1 })).toEqual([]);
    expect(missingInvestmentFields(etfs, { ticker: null, assetQuantity: 1, assetPrice: 1 })).toEqual(['ticker']);
  });

  it('is empty for categories without mandatory enrichment', () => {
    expect(missingInvestmentFields(groceries, {})).toEqual([]);
    expect(missingInvestmentFields(null, {})).toEqual([]);
  });

  it('agrees with isInvestmentEnrichmentComplete', () => {
    expect(isInvestmentEnrichmentComplete(stocks, { ticker: 'AAPL', assetQuantity: 1, assetPrice: 1 })).toBe(true);
    expect(isInvestmentEnrichmentComplete(stocks, { ticker: 'AAPL', assetQuantity: 1 })).toBe(false);
  });
});
