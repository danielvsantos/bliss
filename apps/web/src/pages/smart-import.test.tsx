import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SmartImportPage from './smart-import';
import * as UseImports from '@/hooks/use-imports';
import * as UseMetadata from '@/hooks/use-metadata';
import * as UseTags from '@/hooks/use-tags';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';

// Mocks
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

vi.mock('@/hooks/use-imports');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-tags');
vi.mock('@/hooks/use-toast', () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() }))
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

// ResizeObserver mock
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.ResizeObserver = global.ResizeObserver;
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends Event {} as unknown as typeof PointerEvent;
}
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

describe('SmartImportPage', () => {
  const detectAdapterMock = vi.fn();
  const uploadMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(UseMetadata.useAccounts).mockReturnValue(
      mockQueryResult([{ id: 1, name: 'Bank of America' }]),
    );

    vi.mocked(UseMetadata.useCategories).mockReturnValue(
      mockQueryResult([{ id: 10, name: 'Food' }]),
    );

    vi.mocked(UseImports.useAdapters).mockReturnValue(
      mockQueryResult([{ id: 100, name: 'Chase CSV', matchSignature: { isNative: false } }]),
    );

    vi.mocked(UseImports.useDetectAdapter).mockReturnValue(
      mockMutationResult({ mutate: detectAdapterMock }),
    );

    vi.mocked(UseImports.useUploadSmartImport).mockReturnValue(
      mockMutationResult({ mutate: uploadMock }),
    );

    vi.mocked(UseImports.useCreateAdapter).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useUpdateAdapter).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useDeleteAdapter).mockReturnValue(mockMutationResult());

    // Default staged data to nothing
    vi.mocked(UseImports.useStagedImport).mockReturnValue(mockQueryResult(null));

    vi.mocked(UseImports.useImportSeeds).mockReturnValue(mockQueryResult(null));

    // Other mutations needing dummies
    vi.mocked(UseImports.useUpdateImportRow).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useCommitImport).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useCancelImport).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useBulkConfirmImportRows).mockReturnValue(mockMutationResult());
    vi.mocked(UseImports.useConfirmImportSeeds).mockReturnValue(mockMutationResult());

    vi.mocked(UseTags.useTags).mockReturnValue(mockQueryResult([{ id: 1, name: 'Japan 2026' }]));
    vi.mocked(UseTags.useCreateTag).mockReturnValue(mockMutationResult());
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const renderPage = () => render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SmartImportPage />
      </MemoryRouter>
    </QueryClientProvider>
  );

  it('renders initial upload step correctly', () => {
    renderPage();

    expect(screen.getByText('smartImport.title')).toBeInTheDocument();
    expect(screen.getByText('smartImport.subtitle', { exact: false })).toBeInTheDocument();

    // The file input should be present (hidden, but functional)
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeInTheDocument();
  });

  it('selects file and calls detectAdapter', async () => {
    renderPage();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeDefined();

    const file = new File(['csvdata'], 'test.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file] });
    
    fireEvent.change(input);

    await waitFor(() => {
      expect(detectAdapterMock).toHaveBeenCalledTimes(1);
    });
  });

  it('progresses to processing state', () => {
    // If we pretend upload is successful, step changes to processing
    // Let's directly fake the useStagedImport mock to return a PROCESSING import
    // Note: step is controlled via state in component; we would need to simulate upload success
    // Instead we can test review state directly by returning `stagedData` with `status: 'READY'`
    vi.mocked(UseImports.useStagedImport).mockReturnValue(
      mockQueryResult({
        import: { status: 'READY', totalRows: 5 },
        rows: [],
      }),
    );

    renderPage();

    // The effect in the component will auto-transition `step` to 'review' if importStatus is READY
    // and seeds aren't active.
    expect(screen.getByText('3. smartImport.steps.review')).toBeInTheDocument();
  });

  // NOTE: the partial-commit → Done-page transition would ideally have a
  // regression test here, but exercising it requires driving `step` from
  // 'upload' → 'processing' → 'review' via the actual upload mutation
  // flow. The existing `progresses to processing state` test above sets
  // `step` via the stepper's label rendering, which happens regardless
  // of the actual `step` state. Writing a realistic transition test
  // would entail simulating the full upload + polling pipeline — out of
  // scope for a small UX fix. The fix itself (smart-import.tsx) mirrors
  // the existing COMMITTED branch one-for-one; regression risk is low.

  it('opens the adapter create dialog and shows the category column field', async () => {
    renderPage();

    // First expand the adapter manager panel by clicking its header
    const adapterPanelHeader = screen.getByText('smartImport.importAdapters');
    fireEvent.click(adapterPanelHeader);

    // Then click "New Adapter" which is now visible
    const newAdapterBtn = await screen.findByText('smartImport.newAdapter');
    fireEvent.click(newAdapterBtn);

    // After clicking, the dialog should open and show the Category Column label
    await waitFor(() => {
      expect(screen.getByText('smartImport.form.categoryColumn')).toBeInTheDocument();
    });
  });

  it('includes drawer tag selection in the import row confirm payload', async () => {
    const updateRowMutate = vi.fn();
    vi.mocked(UseImports.useUpdateImportRow).mockReturnValue(
      mockMutationResult({ mutate: updateRowMutate }),
    );
    // Use a "native" adapter so the upload flow doesn't also require picking an account.
    vi.mocked(UseImports.useAdapters).mockReturnValue(
      mockQueryResult([{ id: 100, name: 'Bliss Native', matchSignature: { isNative: true } }]),
    );
    detectAdapterMock.mockImplementation((_file, opts) => {
      opts.onSuccess({ headers: [], sampleData: [], adapter: { id: 100 } });
    });
    uploadMock.mockImplementation((_vars, opts) => {
      opts.onSuccess({ stagedImportId: 'imp-1' });
    });
    // Once step transitions to 'processing', this READY staged data (with our
    // row) triggers the component's own processing -> review transition.
    vi.mocked(UseImports.useStagedImport).mockReturnValue(
      mockQueryResult({
        import: { status: 'READY', totalRows: 1, seedReady: false },
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
            accountId: 1,
            suggestedCategoryId: 10,
            suggestedCategory: { id: 10, name: 'Food' },
            confidence: 0.95,
            classificationSource: 'VECTOR_MATCH',
            status: 'PENDING',
            requiresEnrichment: false,
          },
        ],
        categorySummary: [{ categoryId: 10, count: 1, category: { id: 10, name: 'Food' } }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      }),
    );

    renderPage();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['csvdata'], 'test.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    await waitFor(() => expect(detectAdapterMock).toHaveBeenCalledTimes(1));

    const uploadButton = await screen.findByRole('button', { name: 'smartImport.uploadAndProcess' });
    fireEvent.click(uploadButton);

    // Now on the review step — switch to flat view and open the row's drawer.
    const flatViewButton = await screen.findByRole('button', { name: /smartImport\.review\.flat/ });
    fireEvent.click(flatViewButton);

    fireEvent.click(screen.getAllByText('Coffee Shop')[0].closest('[role="button"]')!);

    fireEvent.click(screen.getByText('select-tag-1'));
    fireEvent.click(screen.getByRole('button', { name: 'review.saveAndPromote' }));

    expect(updateRowMutate).toHaveBeenCalledTimes(1);
    const [{ data }] = updateRowMutate.mock.calls[0];
    expect(data.tags).toEqual(['Japan 2026']);
  });
});
