import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import type {
  DetectAdapterResult,
  StagedImportResponse,
  CreateAdapterRequest,
} from '@/types/api';
import {
  useAdapters,
  useCreateAdapter,
  useDetectAdapter,
  useUploadSmartImport,
  useStagedImport,
  useCommitImport,
  useConfirmImportSeeds,
  importKeys
} from './use-imports';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
    queryClient
  };
};

describe('Smart Import Hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useAdapters', () => {
    it('fetches adapters successfully', async () => {
      const mockAdapters = [{ id: 1, name: 'Chase' }] as unknown as Awaited<ReturnType<typeof api.getAdapters>>;
      vi.mocked(api.getAdapters).mockResolvedValueOnce(mockAdapters);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAdapters(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.getAdapters).toHaveBeenCalled();
      expect(result.current.data).toEqual(mockAdapters);
    });
  });

  describe('useCreateAdapter', () => {
    it('creates adapter and invalidates adapters list', async () => {
      const createdAdapter = { id: 2, name: 'Test' } as unknown as Awaited<ReturnType<typeof api.createAdapter>>;
      vi.mocked(api.createAdapter).mockResolvedValueOnce(createdAdapter);
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useCreateAdapter(), { wrapper });

      const createRequest = { name: 'Test' } as unknown as CreateAdapterRequest;
      act(() => {
        result.current.mutate(createRequest);
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.createAdapter).toHaveBeenCalledWith({ name: 'Test' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: importKeys.adapters() });
    });
  });

  describe('useDetectAdapter', () => {
    it('detects adapter from file', async () => {
      const mockResult: DetectAdapterResult = {
        matched: true,
        adapter: {
          id: 1,
          name: 'Native',
          columnMapping: {},
          amountStrategy: 'SINGLE_SIGNED',
          skipRows: 0,
        },
        confidence: 1,
      };
      vi.mocked(api.detectAdapter).mockResolvedValueOnce(mockResult);
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useDetectAdapter(), { wrapper });
      const testFile = new File(['text'], 'test.csv', { type: 'text/csv' });

      act(() => {
        result.current.mutate(testFile);
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.detectAdapter).toHaveBeenCalledWith(testFile);
      expect(result.current.data).toEqual(mockResult);
    });
  });

  describe('useStagedImport', () => {
    it('does not fetch if id is missing', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useStagedImport(null), { wrapper });
      expect(result.current.fetchStatus).toBe('idle');
      expect(api.getStagedImport).not.toHaveBeenCalled();
    });

    it('fetches staged import if id is present', async () => {
      const stagedFixture = { import: { id: 'import-1' } } as unknown as StagedImportResponse;
      vi.mocked(api.getStagedImport).mockResolvedValueOnce(stagedFixture);
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useStagedImport('import-1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.getStagedImport).toHaveBeenCalledWith('import-1', undefined);
    });
  });

  describe('useCommitImport', () => {
    it('commits import and invalidates staged/pending queries', async () => {
      vi.mocked(api.commitImport).mockResolvedValueOnce({ success: true });
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useCommitImport(), { wrapper });

      act(() => {
        result.current.mutate({ id: 'import-1' });
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.commitImport).toHaveBeenCalledWith('import-1', undefined);
      
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: importKeys.staged('import-1') });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: importKeys.pending() });
    });
  });
});
