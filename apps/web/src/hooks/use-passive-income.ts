import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { IncomeTermsRequest, PassiveIncomeResponse, IncomeStreamsResponse, AssetIncomeTermsResponse } from '@/types/passive-income';

/**
 * Passive Income Projection (#77) hooks.
 *
 * The projection is computed on read by the API, so saving income terms or
 * streams only needs to invalidate these queries (plus Equity Analysis, whose
 * weighted yield honours dividend overrides). No background job is involved.
 */
export const passiveIncomeKeys = {
  all: ['passive-income'] as const,
  projection: (horizon: number) => [...passiveIncomeKeys.all, 'projection', horizon] as const,
  streams: () => [...passiveIncomeKeys.all, 'streams'] as const,
  assetTerms: (assetId: number) => [...passiveIncomeKeys.all, 'asset-terms', assetId] as const,
};

export function usePassiveIncome(horizon: 12 | 24 | 36 = 12) {
  return useQuery<PassiveIncomeResponse>({
    queryKey: passiveIncomeKeys.projection(horizon),
    queryFn: () => api.getPassiveIncome(horizon),
    staleTime: 1000 * 60,
    placeholderData: keepPreviousData,
  });
}

export function useIncomeStreams(enabled = true) {
  return useQuery<IncomeStreamsResponse>({
    queryKey: passiveIncomeKeys.streams(),
    queryFn: () => api.getIncomeStreams(),
    staleTime: 1000 * 60,
    enabled,
  });
}

export function useAssetIncomeTerms(assetId: number | null) {
  return useQuery<AssetIncomeTermsResponse>({
    queryKey: passiveIncomeKeys.assetTerms(assetId ?? 0),
    queryFn: () => api.getAssetIncomeTerms(assetId as number),
    enabled: assetId != null,
  });
}

function useInvalidatePassiveIncome() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: passiveIncomeKeys.all });
    qc.invalidateQueries({ queryKey: ['equity-analysis'] });
    // Holdings rows show whether income terms exist.
    qc.invalidateQueries({ queryKey: ['portfolio-items'] });
  };
}

export function useSaveAssetIncomeTerms() {
  const invalidate = useInvalidatePassiveIncome();
  return useMutation({
    mutationFn: ({ assetId, body }: { assetId: number; body: IncomeTermsRequest }) =>
      api.saveAssetIncomeTerms(assetId, body),
    onSuccess: invalidate,
  });
}

export function useDeleteAssetIncomeTerms() {
  const invalidate = useInvalidatePassiveIncome();
  return useMutation({
    mutationFn: (assetId: number) => api.deleteAssetIncomeTerms(assetId),
    onSuccess: invalidate,
  });
}

export function useSaveIncomeStream() {
  const invalidate = useInvalidatePassiveIncome();
  return useMutation({
    mutationFn: ({ id, body }: { id?: number | null; body: IncomeTermsRequest }) =>
      id ? api.updateIncomeStream(id, body) : api.createIncomeStream(body),
    onSuccess: invalidate,
  });
}

export function useDeleteIncomeStream() {
  const invalidate = useInvalidatePassiveIncome();
  return useMutation({
    mutationFn: (id: number) => api.deleteIncomeStream(id),
    onSuccess: invalidate,
  });
}

export function useAttachIncomeTerms() {
  const invalidate = useInvalidatePassiveIncome();
  return useMutation({
    mutationFn: ({ id, assetId }: { id: number; assetId: number }) => api.attachIncomeTerms(id, assetId),
    onSuccess: invalidate,
  });
}

export function useDiscardIncomeTerms() {
  const invalidate = useInvalidatePassiveIncome();
  return useMutation({
    mutationFn: (id: number) => api.discardIncomeTerms(id),
    onSuccess: invalidate,
  });
}
