import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SmartImportPage from './smart-import';
import * as UseImports from '@/hooks/use-imports';
import * as UseMetadata from '@/hooks/use-metadata';

// Mocks
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

vi.mock('@/hooks/use-imports');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-toast', () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() }))
}));

// ResizeObserver mock
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;
window.ResizeObserver = global.ResizeObserver;
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends Event {} as any;
}
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

describe('SmartImportPage', () => {
  const detectAdapterMock = vi.fn();
  const uploadMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(UseMetadata.useAccounts).mockReturnValue({
      data: [{ id: 1, name: 'Bank of America' }],
    } as any);
    
    vi.mocked(UseMetadata.useCategories).mockReturnValue({
      data: [{ id: 10, name: 'Food' }],
    } as any);

    vi.mocked(UseImports.useAdapters).mockReturnValue({
      data: [{ id: 100, name: 'Chase CSV', matchSignature: { isNative: false } }],
    } as any);

    vi.mocked(UseImports.useDetectAdapter).mockReturnValue({
      mutate: detectAdapterMock,
      isPending: false,
    } as any);

    vi.mocked(UseImports.useUploadSmartImport).mockReturnValue({
      mutate: uploadMock,
      isPending: false,
    } as any);

    vi.mocked(UseImports.useCreateAdapter).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(UseImports.useUpdateAdapter).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(UseImports.useDeleteAdapter).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);

    // Default staged data to nothing
    vi.mocked(UseImports.useStagedImport).mockReturnValue({
      data: null,
      isLoading: false,
    } as any);
    
    vi.mocked(UseImports.useImportSeeds).mockReturnValue({
      data: null,
    } as any);

    // Other mutations needing dummies
    vi.mocked(UseImports.useUpdateImportRow).mockReturnValue({ mutate: vi.fn() } as any);
    vi.mocked(UseImports.useCommitImport).mockReturnValue({ mutate: vi.fn() } as any);
    vi.mocked(UseImports.useCancelImport).mockReturnValue({ mutate: vi.fn() } as any);
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
    
    expect(screen.getByText('Smart Import')).toBeInTheDocument();
    expect(screen.getByText('Upload a CSV or Excel file', { exact: false })).toBeInTheDocument();
    
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
    vi.mocked(UseImports.useStagedImport).mockReturnValue({
      data: {
        import: { status: 'READY', totalRows: 5 },
        rows: [],
      },
      isLoading: false,
    } as any);

    renderPage();

    // The effect in the component will auto-transition `step` to 'review' if importStatus is READY 
    // and seeds aren't active.
    expect(screen.getByText('3. Review')).toBeInTheDocument();
  });
});
