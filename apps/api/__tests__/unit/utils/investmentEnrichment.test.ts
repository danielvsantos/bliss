import { describe, it, expect } from 'vitest';
import {
  MANDATORY_ENRICHMENT_HINTS,
  requiresInvestmentEnrichment,
  missingInvestmentFields,
  missingInvestmentFieldsError,
} from '../../../utils/investmentEnrichment.js';

const cat = (processingHint: string | null, type = 'Investments') => ({ name: 'ETFs', type, processingHint });
const funds = { name: 'Funds', type: 'Investments', processingHint: 'API_FUND', defaultCategoryCode: 'INVESTMENT_FUNDS' };

describe('investmentEnrichment', () => {
  it('applies to stock, fund/ETF and crypto investments only', () => {
    expect(MANDATORY_ENRICHMENT_HINTS).toEqual(['API_STOCK', 'API_CRYPTO', 'API_FUND']);
    for (const hint of MANDATORY_ENRICHMENT_HINTS) expect(requiresInvestmentEnrichment(cat(hint))).toBe(true);
    expect(requiresInvestmentEnrichment(cat('MANUAL'))).toBe(false);
    expect(requiresInvestmentEnrichment(cat('API_STOCK', 'Essentials'))).toBe(false);
    expect(requiresInvestmentEnrichment(null)).toBe(false);
  });

  it('lists every missing field', () => {
    expect(missingInvestmentFields(cat('API_STOCK'), {})).toEqual(['ticker', 'assetQuantity', 'assetPrice']);
    expect(missingInvestmentFields(cat('API_CRYPTO'), {})).toEqual(['ticker', 'assetQuantity', 'assetPrice']);
    expect(missingInvestmentFields(cat('API_FUND'), { ticker: 'VWCE' })).toEqual(['assetQuantity', 'assetPrice']);
  });

  // Private / unlisted funds have no ticker: in the built-in Funds category,
  // quantity + price are enough.
  it('does not require a ticker in the built-in Funds category', () => {
    expect(missingInvestmentFields(funds, {})).toEqual(['assetQuantity', 'assetPrice']);
    expect(missingInvestmentFields(funds, { assetQuantity: 10, assetPrice: 1000 })).toEqual([]);
  });

  // ETFs share API_FUND but always have a ticker; a code-less API_FUND category
  // (pre-code tenant) stays strict too.
  it('still requires a ticker for ETFs and for API_FUND categories without a code', () => {
    const qtyPrice = { assetQuantity: 10, assetPrice: 100 };
    expect(missingInvestmentFields({ ...cat('API_FUND'), defaultCategoryCode: 'ETFS' }, qtyPrice)).toEqual(['ticker']);
    expect(missingInvestmentFields({ ...cat('API_FUND'), defaultCategoryCode: null }, qtyPrice)).toEqual(['ticker']);
    expect(missingInvestmentFields(cat('API_FUND'), qtyPrice)).toEqual(['ticker']);
  });

  it('treats zero, empty strings, non-numbers and letter-less tickers as missing', () => {
    expect(missingInvestmentFields(cat('API_STOCK'), { ticker: '123', assetQuantity: '', assetPrice: 'abc' }))
      .toEqual(['ticker', 'assetQuantity', 'assetPrice']);
    expect(missingInvestmentFields(cat('API_STOCK'), { ticker: 'AAPL', assetQuantity: 0, assetPrice: 0 }))
      .toEqual(['assetQuantity', 'assetPrice']);
  });

  it('accepts a signed sell quantity and numeric strings', () => {
    expect(missingInvestmentFields(cat('API_CRYPTO'), { ticker: 'BTC/EUR', assetQuantity: '-0.5', assetPrice: '60000' }))
      .toEqual([]);
  });

  it('requires nothing for other categories', () => {
    expect(missingInvestmentFields(cat('MANUAL'), {})).toEqual([]);
    expect(missingInvestmentFields(undefined, {})).toEqual([]);
  });

  it('builds a 400 body naming the category and the missing fields', () => {
    expect(missingInvestmentFieldsError({ ...cat('API_STOCK'), name: 'Stocks' }, ['ticker'])).toEqual({
      error: expect.stringContaining('Stocks transactions require ticker, assetQuantity and assetPrice'),
      missingFields: ['ticker'],
    });
    expect(missingInvestmentFieldsError(funds, ['assetPrice'])).toEqual({
      error: expect.stringContaining('Funds transactions require assetQuantity and assetPrice (greater than 0); ticker is optional'),
      missingFields: ['assetPrice'],
    });
  });
});
