import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { api } from '@/lib/api';
import { PORTFOLIO_ITEMS_QUERY_KEY } from '@/hooks/use-portfolio-items';
import { EQUITY_ANALYSIS_QUERY_KEY } from '@/hooks/use-equity-analysis';
import { MANAGE_ASSETS_QUERY_KEY } from '@/hooks/use-manage-assets';
import type { EtoroConnectRequest, EtoroUpdateRequest } from '@/types/api';

/**
 * eToro copy trading (#143): connections (Settings → Bank sync) and the
 * "Switch to Copy Trading" action (Manage Assets).
 *
 * Keys are write-only: they travel in the connect / replace request and
 * nowhere else. Those mutations are never cached (`gcTime: 0`) so their
 * variables do not outlive the request.
 */

export const etoroKeys = {
  all: ['etoro'] as const,
  connections: () => [...etoroKeys.all, 'connections'] as const,
};

export type EtoroErrorBody = { error?: string; code?: string; retryAfter?: number; writeScopes?: string[] };

export function etoroError(error: unknown): { status?: number; body: EtoroErrorBody } {
  const ax = error as AxiosError<EtoroErrorBody> | undefined;
  return { status: ax?.response?.status, body: ax?.response?.data ?? {} };
}

export function useEtoroConnections(enabled = true) {
  return useQuery({
    queryKey: etoroKeys.connections(),
    queryFn: () => api.getEtoroConnections(),
    enabled,
    staleTime: 30_000,
  });
}

/** Holdings, Equity Analysis and Manage Assets show link status and values. */
function useInvalidatePortfolio() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: etoroKeys.all });
    queryClient.invalidateQueries({ queryKey: [PORTFOLIO_ITEMS_QUERY_KEY] });
    queryClient.invalidateQueries({ queryKey: [EQUITY_ANALYSIS_QUERY_KEY] });
    queryClient.invalidateQueries({ queryKey: [MANAGE_ASSETS_QUERY_KEY] });
  };
}

export function useConnectEtoro() {
  const invalidate = useInvalidatePortfolio();
  return useMutation({
    mutationFn: (data: EtoroConnectRequest) => api.connectEtoro(data),
    gcTime: 0,
    onSuccess: () => invalidate(),
  });
}

export function useUpdateEtoroConnection() {
  const invalidate = useInvalidatePortfolio();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: EtoroUpdateRequest }) => api.updateEtoroConnection(id, data),
    gcTime: 0,
    onSuccess: () => invalidate(),
  });
}

export function useRemoveEtoroConnection() {
  const invalidate = useInvalidatePortfolio();
  return useMutation({
    mutationFn: (id: string) => api.removeEtoroConnection(id),
    onSuccess: () => invalidate(),
  });
}

export function useSyncEtoroConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.syncEtoroConnection(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: etoroKeys.all }),
  });
}

export function useConvertToCopyTrading() {
  const invalidate = useInvalidatePortfolio();
  return useMutation({
    mutationFn: ({ portfolioItemId, etoroUsername }: { portfolioItemId: number; etoroUsername: string }) =>
      api.convertToCopyTrading(portfolioItemId, etoroUsername),
    onSuccess: () => invalidate(),
  });
}
