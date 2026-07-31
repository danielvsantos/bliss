import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TransactionReviewPage from './transaction-review';
import * as UsePlaidReview from '@/hooks/use-plaid-review';
import * as UseImports from '@/hooks/use-imports';
import * as UseMetadata from '@/hooks/use-metadata';
import * as UseTags from '@/hooks/use-tags';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-plaid-review');
vi.mock('@/hooks/use-imports');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-tags');
vi.mock('@/hooks/use-toast', () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() })),
}));

// TagInput's own Radix/cmdk internals aren't the concern here — stub it so
// tests can assert the drawer-to-page wiring (tagNames -> payload.tags)
// without driving the real combobox.
vi.mock('@/components/entities/tag-input', () => ({
  TagInput: ({
    selectedTagIds,
    onChange,
  }: {
    selectedTagIds: number[];
    onChange: (ids: number[]) => void;
  }) => (
    <button type="button" onClick={() => onChange([...selectedTagIds, 1])}>
      select-tag-1
    </button>
  ),
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
  summary: { classified: 0, promoted: 0, skipped: 0, pending: 0, failed: 0, seedHeld: 0, categoryBreakdown: [] },
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
    vi.mocked(UsePlaidReview.useRetryPlaidTransaction).mockReturnValue(mockMutationResult());

    vi.mocked(UseImports.usePendingImports).mockReturnValue(
      mockQueryResult({ imports: [] }),
    );
    vi.mocked(UseImports.useStagedImport).mockReturnValue(mockQueryResult(null));
    vi.mocked(UseImports.useUpdateImportRow).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useCommitImport).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useCancelImport).mockReturnValue(mockMutationResult());

    vi.mocked(UseTags.useTags).mockReturnValue(mockQueryResult([{ id: 1, name: 'Japan 2026' }]));
    vi.mocked(UseTags.useCreateTag).mockReturnValue(mockMutationResult());
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

  it('includes drawer tag selection in the Plaid promote payload', () => {
    const updateMutate = vi.fn();
    vi.mocked(UsePlaidReview.useUpdatePlaidTransaction).mockReturnValue(
      mockMutationResult({ mutate: updateMutate }),
    );
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

    // Switch to flat view so the row is directly clickable (grouped view
    // requires expanding a category card first).
    fireEvent.click(screen.getByText('Grouped'));
    fireEvent.click(screen.getAllByText('Whole Foods')[0].closest('[role="button"]')!);

    // Select a tag via the stubbed TagInput, then save.
    fireEvent.click(screen.getByText('select-tag-1'));
    fireEvent.click(screen.getByRole('button', { name: 'review.saveAndPromote' }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [{ data }] = updateMutate.mock.calls[0];
    expect(data.tags).toEqual(['Japan 2026']);
  });

  it('propagates the drawer tag selection to bulk-promoted matching transactions', () => {
    const updateMutate = vi.fn();
    const bulkPromoteMutate = vi.fn();
    vi.mocked(UsePlaidReview.useUpdatePlaidTransaction).mockReturnValue(
      mockMutationResult({ mutate: updateMutate }),
    );
    vi.mocked(UsePlaidReview.useBulkPromotePlaidTransactions).mockReturnValue(
      mockMutationResult({ mutate: bulkPromoteMutate }),
    );
    vi.mocked(UsePlaidReview.usePlaidTransactions).mockReturnValue(
      mockQueryResult({
        ...emptyPlaidData,
        transactions: [
          {
            id: 'tx-1',
            plaidItemId: 'item-1',
            plaidAccountId: 'acc-1',
            plaidTransactionId: 'plaid-tx-1',
            name: 'STARBUCKS #1234',
            merchantName: 'Starbucks',
            amount: 4.5,
            date: '2025-05-01',
            isoCurrencyCode: 'USD',
            promotionStatus: 'CLASSIFIED',
            suggestedCategoryId: 10,
            suggestedCategory: { id: 10, name: 'Dining' },
            aiConfidence: 0.95,
            classificationSource: 'VECTOR_MATCH',
            requiresEnrichment: false,
          },
          {
            id: 'tx-2',
            plaidItemId: 'item-1',
            plaidAccountId: 'acc-1',
            plaidTransactionId: 'plaid-tx-2',
            name: 'STARBUCKS #1234',
            merchantName: 'Starbucks',
            amount: 5.0,
            date: '2025-05-02',
            isoCurrencyCode: 'USD',
            promotionStatus: 'CLASSIFIED',
            suggestedCategoryId: 10,
            suggestedCategory: { id: 10, name: 'Dining' },
            aiConfidence: 0.9,
            classificationSource: 'VECTOR_MATCH',
            requiresEnrichment: false,
          },
        ],
        summary: {
          classified: 2,
          promoted: 0,
          skipped: 0,
          pending: 0,
          seedHeld: 0,
          categoryBreakdown: [{ categoryId: 10, count: 2, category: { id: 10, name: 'Dining' } }],
        },
      }),
    );

    renderPage();

    fireEvent.click(screen.getByText('Grouped'));
    fireEvent.click(screen.getAllByText('Starbucks')[0].closest('[role="button"]')!);

    fireEvent.click(screen.getByText('select-tag-1'));
    fireEvent.click(screen.getByRole('button', { name: 'review.saveAndPromote' }));

    // A same-description match exists, so saving opens the "promote all
    // matches" dialog instead of saving immediately — confirm "promote all"
    // to exercise the bulk fan-out path.
    fireEvent.click(screen.getByRole('button', { name: 'review.confirmAllCount' }));

    expect(bulkPromoteMutate).toHaveBeenCalledTimes(1);
    const [payload] = bulkPromoteMutate.mock.calls[0];
    expect(payload.tags).toEqual(['Japan 2026']);
  });

  it('includes drawer tag selection in the import confirm payload', () => {
    const updateRowMutate = vi.fn();
    vi.mocked(UseImports.useUpdateImportRow).mockReturnValue(
      mockMutationResult({ mutate: updateRowMutate }),
    );
    vi.mocked(UseImports.usePendingImports).mockReturnValue(
      mockQueryResult({ imports: [{ id: 'imp-1', fileName: 'march.csv', pendingRowCount: 1 }] }),
    );
    vi.mocked(UseImports.useStagedImport).mockReturnValue(
      mockQueryResult({
        import: { id: 'imp-1', fileName: 'march.csv' },
        rows: [
          {
            id: 'row-1',
            stagedImportId: 'imp-1',
            rowNumber: 1,
            rawData: {},
            transactionDate: '2025-05-01',
            description: 'Coffee Shop',
            debit: 8,
            credit: 0,
            currency: 'USD',
            accountId: 42,
            suggestedCategoryId: 10,
            suggestedCategory: { id: 10, name: 'Groceries' },
            confidence: 0.95,
            classificationSource: 'VECTOR_MATCH',
            status: 'PENDING',
            requiresEnrichment: false,
          },
        ],
        categorySummary: [{ categoryId: 10, count: 1, category: { id: 10, name: 'Groceries' } }],
        pagination: { page: 1, limit: 50, total: 1 },
      }),
    );
    vi.mocked(UseMetadata.useAccounts).mockReturnValue(
      mockQueryResult([{ id: 42, name: 'Checking' }]),
    );

    renderPage('?source=imports');

    fireEvent.click(screen.getByText('Grouped'));
    fireEvent.click(screen.getAllByText('Coffee Shop')[0].closest('[role="button"]')!);

    fireEvent.click(screen.getByText('select-tag-1'));
    fireEvent.click(screen.getByRole('button', { name: 'review.saveAndPromote' }));

    expect(updateRowMutate).toHaveBeenCalledTimes(1);
    const [{ data }] = updateRowMutate.mock.calls[0];
    expect(data.tags).toEqual(['Japan 2026']);
  });

  // ─── FAILED transactions — visibility & retry ────────────────────────────

  const FAILED_TX = {
    id: 'tx-failed-1',
    plaidItemId: 'item-1',
    plaidAccountId: 'acc-1',
    plaidTransactionId: 'plaid-tx-failed-1',
    name: 'PAGO CON TARJETA DE TASA',
    merchantName: null,
    amount: 100,
    date: '2025-05-03',
    isoCurrencyCode: 'USD',
    promotionStatus: 'FAILED',
    suggestedCategoryId: null,
    aiConfidence: null,
    classificationSource: null,
    requiresEnrichment: false,
    processingError: 'Gemini classification timed out after 5000ms',
  };

  /** Mocks usePlaidTransactions so the CLASSIFIED-scoped call and the
   *  FAILED-scoped call (both fired by the page) return distinct data,
   *  mirroring how the two independently-parameterized API calls behave
   *  in the real app. */
  function mockPlaidWithFailedRow() {
    vi.mocked(UsePlaidReview.usePlaidTransactions).mockImplementation((params?: { promotionStatus?: string }) => {
      if (params?.promotionStatus === 'FAILED') {
        return mockQueryResult({
          ...emptyPlaidData,
          transactions: [FAILED_TX],
          summary: { ...emptyPlaidData.summary, failed: 1 },
        });
      }
      return mockQueryResult({
        ...emptyPlaidData,
        summary: { ...emptyPlaidData.summary, failed: 1 },
      });
    });
  }

  it('shows FAILED Plaid transactions with a classification-failed badge, not hidden by the CLASSIFIED-only filter', () => {
    mockPlaidWithFailedRow();

    renderPage();

    // Failed-count banner in the page header is visible regardless of view mode
    expect(screen.getByText('review.failedTransactionsBanner')).toBeInTheDocument();

    // Switch to flat view so the row renders directly (grouped view requires
    // expanding the Uncategorized category card first).
    fireEvent.click(screen.getByText('Grouped'));

    // Status badge label comes from statusLabelKeys['classification-failed'] = 'review.classificationFailed'
    // (desktop + mobile row variants both render in jsdom)
    expect(screen.getAllByText('review.classificationFailed').length).toBeGreaterThan(0);
  });

  it('clicking the retry action on a FAILED row calls the retry mutation with the transaction id', () => {
    mockPlaidWithFailedRow();
    const retryMutate = vi.fn();
    vi.mocked(UsePlaidReview.useRetryPlaidTransaction).mockReturnValue(
      mockMutationResult({ mutate: retryMutate }),
    );

    renderPage();
    fireEvent.click(screen.getByText('Grouped'));

    // Desktop and mobile row variants both render in jsdom (CSS media queries
    // don't hide either in the test DOM) — same pattern as other tests in this
    // file that pick [0] from getAllBy* for dual-rendered row elements.
    fireEvent.click(screen.getAllByTitle('Retry classification')[0]);

    expect(retryMutate).toHaveBeenCalledTimes(1);
    const [id] = retryMutate.mock.calls[0];
    expect(id).toBe('tx-failed-1');
  });
});
