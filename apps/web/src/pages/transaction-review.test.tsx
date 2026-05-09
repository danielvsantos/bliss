import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TransactionReviewPage from './transaction-review';
import * as UsePlaidReview from '@/hooks/use-plaid-review';
import * as UseImports from '@/hooks/use-imports';
import * as UseMetadata from '@/hooks/use-metadata';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-plaid-review');
vi.mock('@/hooks/use-imports');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-toast', () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() })),
}));

// jsdom stubs required by shadcn/ui components used on this page
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends Event {} as unknown as typeof PointerEvent;
}

const emptyPlaidData = {
  transactions: [],
  summary: { classified: 0, promoted: 0, skipped: 0, pending: 0, seedHeld: 0, categoryBreakdown: [] },
  pagination: { total: 0, totalPages: 1, page: 1, limit: 500 },
  accounts: [],
};

describe('TransactionReviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(UseMetadata.useCategories).mockReturnValue(mockQueryResult([]));
    vi.mocked(UseMetadata.useAccounts).mockReturnValue(mockQueryResult([]));

    vi.mocked(UsePlaidReview.usePlaidTransactions).mockReturnValue(
      mockQueryResult(emptyPlaidData),
    );
    vi.mocked(UsePlaidReview.useUpdatePlaidTransaction).mockReturnValue(mockMutationResult());
    vi.mocked(UsePlaidReview.useBulkPromotePlaidTransactions).mockReturnValue(mockMutationResult());

    vi.mocked(UseImports.usePendingImports).mockReturnValue(
      mockQueryResult({ imports: [] }),
    );
    vi.mocked(UseImports.useStagedImport).mockReturnValue(mockQueryResult(null));
    vi.mocked(UseImports.useUpdateImportRow).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useCommitImport).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useCancelImport).mockReturnValue(mockMutationResult());
  });

  const renderPage = (search = '') =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[`/${search}`]}>
          <TransactionReviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('renders without crashing', () => {
    // Catches hook ordering issues (e.g. TDZ from useEffect dep arrays referencing
    // variables declared later in the component body) that only surface on mount.
    expect(() => renderPage()).not.toThrow();
  });

  it('shows the all-caught-up empty state when there are no pending transactions', () => {
    renderPage();
    expect(screen.getByText('review.allCaughtUp')).toBeInTheDocument();
  });

  it('shows pending Plaid transactions in grouped view', () => {
    vi.mocked(UsePlaidReview.usePlaidTransactions).mockReturnValue(
      mockQueryResult({
        ...emptyPlaidData,
        transactions: [
          {
            id: 'tx-1',
            plaidItemId: 'item-1',
            plaidAccountId: 'acc-1',
            plaidTransactionId: 'plaid-tx-1',
            name: 'Whole Foods',
            merchantName: 'Whole Foods',
            amount: 42.5,
            date: '2025-05-01',
            isoCurrencyCode: 'USD',
            promotionStatus: 'CLASSIFIED',
            suggestedCategoryId: 10,
            suggestedCategory: { id: 10, name: 'Groceries' },
            aiConfidence: 0.95,
            classificationSource: 'VECTOR_MATCH',
            requiresEnrichment: false,
          },
        ],
        summary: {
          classified: 1,
          promoted: 0,
          skipped: 0,
          pending: 0,
          seedHeld: 0,
          categoryBreakdown: [{ categoryId: 10, count: 1, category: { id: 10, name: 'Groceries' } }],
        },
      }),
    );

    renderPage();

    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('renders the Plaid tab when ?source=plaid is in the URL', () => {
    renderPage('?source=plaid');
    // With no items the plaid-specific empty state should render
    expect(screen.getByText('review.noPlaidToReview')).toBeInTheDocument();
  });

  it('shows the pending imports tab when imports are present', () => {
    vi.mocked(UseImports.usePendingImports).mockReturnValue(
      mockQueryResult({
        imports: [{ id: 'imp-1', fileName: 'march.csv', pendingRowCount: 12 }],
      }),
    );

    renderPage('?source=imports');

    expect(screen.getByText('march.csv', { exact: false })).toBeInTheDocument();
  });
});
