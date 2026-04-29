import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  ImportAdapter,
  DetectAdapterResult,
  StagedImportResponse,
  CreateAdapterRequest,
  SeedItem,
} from '@/types/api';

// Query keys
export const importKeys = {
  all: ['imports'] as const,
  adapters: () => [...importKeys.all, 'adapters'] as const,
  staged: (id: string) => [...importKeys.all, 'staged', id] as const,
  stagedWithParams: (id: string, params: Record<string, unknown>) =>
    [...importKeys.all, 'staged', id, params] as const,
  pending: () => [...importKeys.all, 'pending'] as const,
  seeds: (id: string) => [...importKeys.all, 'seeds', id] as const,
};

// --- Adapters ---

export function useAdapters() {
  return useQuery({
    queryKey: importKeys.adapters(),
    queryFn: () => api.getAdapters(),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useCreateAdapter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAdapterRequest) => api.createAdapter(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.adapters() });
    },
  });
}

export function useUpdateAdapter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreateAdapterRequest> }) =>
      api.updateAdapter(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.adapters() });
    },
  });
}

export function useDeleteAdapter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteAdapter(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: importKeys.adapters() });
    },
  });
}

// --- Detect Adapter ---

export function useDetectAdapter() {
  return useMutation({
    mutationFn: (file: File) => api.detectAdapter(file),
  });
}

// --- Upload ---

export function useUploadSmartImport() {
  return useMutation({
    mutationFn: (params: { file: File; accountId: number | null; adapterId: string }) =>
      api.uploadSmartImport(params.file, params.accountId, params.adapterId),
  });
}

// --- Staged Import (with polling) ---

export function useStagedImport(
  id: string | null,
  params?: { page?: number; limit?: number; status?: string; categoryId?: number; uncategorized?: boolean },
) {
  return useQuery({
    queryKey: importKeys.stagedWithParams(id ?? '', params ?? {}),
    queryFn: () => api.getStagedImport(id!, params),
    enabled: !!id,
    // Poll every 2s while PROCESSING or COMMITTING, stop when terminal
    refetchInterval: (query) => {
      const status = query.state.data?.import?.status;
      if (status === 'PROCESSING' || status === 'COMMITTING') return 2000;
      return false;
    },
    staleTime: 0, // Always refetch when re-focused
  });
}

// --- Row Update ---

export function useUpdateImportRow(importId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { rowId: string; data: Record<string, unknown> }) =>
      api.updateImportRow(importId!, params.rowId, params.data),
    onSuccess: () => {
      // Invalidate all staged queries for this import to refresh data
      if (importId) {
        queryClient.invalidateQueries({ queryKey: importKeys.staged(importId) });
      }
    },
  });
}

// --- Bulk Confirm (server-side approve-all) ---

export function useBulkConfirmImportRows(importId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { categoryId?: number; uncategorized?: boolean }) =>
      api.bulkConfirmImportRows(importId!, body),
    onSuccess: () => {
      if (importId) {
        queryClient.invalidateQueries({ queryKey: importKeys.staged(importId) });
      }
    },
  });
}

// --- Commit / Cancel ---

export function useCommitImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; rowIds?: string[] }) => api.commitImport(params.id, params.rowIds),
    onSuccess: (_data, params) => {
      // Trigger a refetch so the polling picks up the COMMITTING status
      queryClient.invalidateQueries({ queryKey: importKeys.staged(params.id) });
      queryClient.invalidateQueries({ queryKey: importKeys.pending() });
      // Don't invalidate transactions yet — they're created async by the worker.
      // The smart-import page will invalidate transactions when polling detects COMMITTED.
    },
  });
}

export function useCancelImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelImport(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: importKeys.staged(id) });
      queryClient.invalidateQueries({ queryKey: importKeys.pending() });
    },
  });
}

// --- Pending Imports ---

export function usePendingImports() {
  return useQuery({
    queryKey: importKeys.pending(),
    queryFn: () => api.getPendingImports(),
    staleTime: 1000 * 30,
  });
}

// --- Quick Seed Interview (Smart Import) ---

/**
 * Fetches the top LLM-classified descriptions for the seed interview.
 * Only enabled once the importId is available.
 */
export function useImportSeeds(importId: string | null, limit?: number) {
  return useQuery<SeedItem[]>({
    queryKey: importKeys.seeds(importId ?? ''),
    queryFn: () => api.getImportSeeds(importId!, limit),
    enabled: !!importId,
    staleTime: 1000 * 60 * 5, // Seeds don't change once set — 5 min stale
  });
}

/**
 * Confirms the user's category selections from the Quick Seed interview.
 * Fires recordFeedback on the backend and bulk-updates matching StagedImportRows.
 */
export function useConfirmImportSeeds(importId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (seeds: { description: string; confirmedCategoryId: number }[]) =>
      api.confirmImportSeeds(importId!, seeds),
    onSuccess: () => {
      if (importId) {
        // Seeds are now stale
        queryClient.invalidateQueries({ queryKey: importKeys.seeds(importId) });
        // Staged import rows have been updated — refresh review table
        queryClient.invalidateQueries({ queryKey: importKeys.staged(importId) });
      }
    },
  });
}
