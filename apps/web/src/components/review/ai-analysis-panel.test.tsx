import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { AIAnalysisPanel } from './ai-analysis-panel';
import type { ReviewItem } from './types';

function makeItem(source: string | null): ReviewItem {
  return {
    id: '1',
    source: 'import',
    date: '2026-01-01',
    merchant: 'Test',
    description: 'Test',
    amount: 10,
    currency: 'USD',
    status: 'ai-approved',
    category: 'Food',
    categoryId: 1,
    confidence: 0.9,
    classificationSource: source,
    classificationReasoning: null,
    plaidHint: null,
    accountName: 'Checking',
    requiresEnrichment: false,
    enrichmentType: null,
    promotionStatus: 'CONFIRMED',
  };
}

describe('AIAnalysisPanel source label', () => {
  const cases: Array<[string, string]> = [
    ['USER_OVERRIDE', 'review.sourceLabels.USER_OVERRIDE'],
    ['EXACT_MATCH', 'review.sourceLabels.EXACT_MATCH'],
    ['VECTOR_MATCH', 'review.sourceLabels.VECTOR_MATCH'],
    ['VECTOR_MATCH_GLOBAL', 'review.sourceLabels.VECTOR_MATCH_GLOBAL'],
    ['LLM', 'review.sourceLabels.LLM'],
  ];

  it.each(cases)('renders unique label for %s', (source, expectedKey) => {
    render(<AIAnalysisPanel item={makeItem(source)} />);
    expect(screen.getByText(expectedKey)).toBeInTheDocument();
  });

  it('resolves each source to a distinct translation key', () => {
    const keys = cases.map(([, k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('falls back to unknown when source is null', () => {
    render(<AIAnalysisPanel item={makeItem(null)} />);
    expect(screen.getByText('review.unknown')).toBeInTheDocument();
  });
});
