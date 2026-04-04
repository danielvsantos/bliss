import { describe, it, expect } from 'vitest';
import {
  isMandatoryEnrichmentCategory,
  isInvestmentCategory,
  itemNeedsEnrichment,
} from './investment-utils';
import type { Category } from '@/types/api';
import type { ReviewItem } from '@/components/review/types';

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 1,
    name: 'Stocks',
    group: 'Stocks',
    type: 'Investments',
    tenantId: 'tenant-1',
    processingHint: 'API_STOCK',
    ...overrides,
  };
}

const BASE_REVIEW_ITEM: ReviewItem = {
  id: '1',
  source: 'plaid',
  date: '2025-01-01',
  merchant: 'Test',
  description: 'Test transaction',
  amount: 100,
  currency: 'USD',
  status: 'needs-enrichment',
  category: 'Stocks',
  categoryId: 1,
  confidence: 0.95,
  classificationSource: 'LLM',
  classificationReasoning: null,
  plaidHint: null,
  accountName: 'Main',
  requiresEnrichment: false,
  enrichmentType: null,
  promotionStatus: 'PENDING',
};

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return Object.assign({}, BASE_REVIEW_ITEM, overrides);
}

describe('isMandatoryEnrichmentCategory', () => {
  it('returns true for API_STOCK with type Investments', () => {
    expect(isMandatoryEnrichmentCategory(makeCategory({ processingHint: 'API_STOCK' }))).toBe(true);
  });

  it('returns true for API_CRYPTO with type Investments', () => {
    expect(isMandatoryEnrichmentCategory(makeCategory({ processingHint: 'API_CRYPTO' }))).toBe(true);
  });

  it('returns true for API_FUND with type Investments', () => {
    expect(isMandatoryEnrichmentCategory(makeCategory({ processingHint: 'API_FUND' }))).toBe(true);
  });

  it('returns false for MANUAL hint', () => {
    expect(isMandatoryEnrichmentCategory(makeCategory({ processingHint: 'MANUAL' }))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isMandatoryEnrichmentCategory(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isMandatoryEnrichmentCategory(undefined)).toBe(false);
  });

  it('returns false for non-Investments type', () => {
    expect(isMandatoryEnrichmentCategory(
      makeCategory({ type: 'Income', processingHint: 'API_STOCK' }),
    )).toBe(false);
  });
});

describe('isInvestmentCategory', () => {
  it('returns true for mandatory hints (API_STOCK)', () => {
    expect(isInvestmentCategory(makeCategory({ processingHint: 'API_STOCK' }))).toBe(true);
  });

  it('returns true for optional hints (MANUAL)', () => {
    expect(isInvestmentCategory(makeCategory({ processingHint: 'MANUAL' }))).toBe(true);
  });

  it('returns false for null', () => {
    expect(isInvestmentCategory(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isInvestmentCategory(undefined)).toBe(false);
  });

  it('returns false for non-Investments type with investment hint', () => {
    expect(isInvestmentCategory(
      makeCategory({ type: 'Income', processingHint: 'API_STOCK' }),
    )).toBe(false);
  });
});

describe('itemNeedsEnrichment', () => {
  it('returns true when item.requiresEnrichment is true', () => {
    const item = makeReviewItem({ requiresEnrichment: true });
    const map = new Map<number, Category>();
    expect(itemNeedsEnrichment(item, map)).toBe(true);
  });

  it('returns true when category is mandatory enrichment', () => {
    const cat = makeCategory({ processingHint: 'API_STOCK' });
    const map = new Map<number, Category>([[1, cat]]);
    const item = makeReviewItem({ requiresEnrichment: false, categoryId: 1 });
    expect(itemNeedsEnrichment(item, map)).toBe(true);
  });

  it('returns false when no categoryId', () => {
    const map = new Map<number, Category>();
    const item = makeReviewItem({ requiresEnrichment: false, categoryId: null });
    expect(itemNeedsEnrichment(item, map)).toBe(false);
  });

  it('returns false when category is not mandatory enrichment', () => {
    const cat = makeCategory({ processingHint: 'MANUAL' });
    const map = new Map<number, Category>([[1, cat]]);
    const item = makeReviewItem({ requiresEnrichment: false, categoryId: 1 });
    expect(itemNeedsEnrichment(item, map)).toBe(false);
  });
});
