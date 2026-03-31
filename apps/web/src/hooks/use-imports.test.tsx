import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
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
      vi.mocked(api.getAdapters).mockResolvedValueOnce({ adapters: [{ id: 1, name: 'Chase' }] } as any);
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAdapters(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.getAdapters).toHaveBeenCalled();
      expect(result.current.data).toEqual({ adapters: [{ id: 1, name: 'Chase' }] });
    });
  });

  describe('useCreateAdapter', () => {
    it('creates adapter and invalidates adapters list', async () => {
      vi.mocked(api.createAdapter).mockResolvedValueOnce({ success: true } as any);
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useCreateAdapter(), { wrapper });

      act(() => {
        result.current.mutate({ name: 'Test' } as any);
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.createAdapter).toHaveBeenCalledWith({ name: 'Test' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: importKeys.adapters() });
    });
  });

  describe('useDetectAdapter', () => {
    it('detects adapter from file', async () => {
      const mockResult = { adapter: { id: 1, name: 'Native' }, confidence: 1 };
      vi.mocked(api.detectAdapter).mockResolvedValueOnce(mockResult as any);
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
      vi.mocked(api.getStagedImport).mockResolvedValueOnce({ import: { id: 'import-1' } } as any);
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
