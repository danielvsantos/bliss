import { describe, it, expect } from 'vitest';
import {
  MANDATORY_ENRICHMENT_HINTS,
  requiresInvestmentEnrichment,
  missingInvestmentFields,
  missingInvestmentFieldsError,
} from '../../../utils/investmentEnrichment.js';

const cat = (processingHint: string | null, type = 'Investments') => ({ name: 'ETFs', type, processingHint });

describe('investmentEnrichment', () => {
  it('applies to stock, fund/ETF and crypto investments only', () => {
    expect(MANDATORY_ENRICHMENT_HINTS).toEqual(['API_STOCK', 'API_CRYPTO', 'API_FUND']);
    for (const hint of MANDATORY_ENRICHMENT_HINTS) expect(requiresInvestmentEnrichment(cat(hint))).toBe(true);
    expect(requiresInvestmentEnrichment(cat('MANUAL'))).toBe(false);
    expect(requiresInvestmentEnrichment(cat('API_STOCK', 'Essentials'))).toBe(false);
    expect(requiresInvestmentEnrichment(null)).toBe(false);
  });

  it('lists every missing field', () => {
    expect(missingInvestmentFields(cat('API_FUND'), {})).toEqual(['ticker', 'assetQuantity', 'assetPrice']);
    expect(missingInvestmentFields(cat('API_FUND'), { ticker: 'VWCE' })).toEqual(['assetQuantity', 'assetPrice']);
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
    expect(missingInvestmentFieldsError(cat('API_FUND'), ['assetPrice'])).toEqual({
      error: expect.stringContaining('ETFs transactions require ticker, assetQuantity and assetPrice'),
      missingFields: ['assetPrice'],
    });
  });
});
