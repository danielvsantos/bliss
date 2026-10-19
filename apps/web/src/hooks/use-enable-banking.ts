import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { api } from '@/lib/api';
import { accountListKeys } from '@/hooks/use-account-list';
import { metadataKeys } from '@/hooks/use-metadata';
import { plaidItemKeys } from '@/hooks/use-plaid-actions';
import type {
  EnableBankingConnectRequest,
  EnableBankingErrorBody,
  EnableBankingMapRequest,
} from '@/types/api';

// Query keys for Enable Banking (#132)
export const enableBankingKeys = {
  all: ['enable-banking'] as const,
  status: () => [...enableBankingKeys.all, 'status'] as const,
  aspsps: () => [...enableBankingKeys.all, 'aspsps'] as const,
  connection: (id: string) => [...enableBankingKeys.all, 'connection', id] as const,
};

/** The `{ code, … }` body of an Enable Banking API error, if any. */
export function enableBankingError(error: unknown): { status?: number; body: EnableBankingErrorBody } {
  const ax = error as AxiosError<EnableBankingErrorBody> | undefined;
  return { status: ax?.response?.status, body: ax?.response?.data ?? {} };
}

/** Invalidate everything a connection change can affect: the connection, bank items and accounts. */
function invalidateConnectionQueries(queryClient: QueryClient, id?: string) {
  if (id) queryClient.invalidateQueries({ queryKey: enableBankingKeys.connection(id) });
  queryClient.invalidateQueries({ queryKey: plaidItemKeys.all });
  queryClient.invalidateQueries({ queryKey: accountListKeys.all });
  queryClient.invalidateQueries({ queryKey: metadataKeys.all });
}

// --- Is Enable Banking set up for this tenant? (hidden everywhere when not) ---

export function useEnableBankingStatus(enabled = true) {
  return useQuery({
    queryKey: enableBankingKeys.status(),
    queryFn: () => api.getEnableBankingStatus(),
    enabled,
    // Tenant admins change credentials in Settings → Bank sync (#148); saving
    // invalidates this key, the stale time only bounds other tabs and users.
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
}

/** True only when the API confirmed the tenant has Enable Banking credentials. */
export function useEnableBankingEnabled(enabled = true): boolean {
  const { data } = useEnableBankingStatus(enabled);
  return enabled && data?.enabled === true;
}

// --- Banks available in the tenant's countries (only while the dialog is open) ---

export function useEnableBankingAspsps(enabled: boolean) {
  return useQuery({
    queryKey: enableBankingKeys.aspsps(),
    queryFn: () => api.getEnableBankingAspsps(),
    enabled,
    staleTime: 1000 * 60 * 10,
    retry: false,
  });
}

// --- One connection, its bank accounts and the tenant's Bliss accounts ---

export function useEnableBankingConnection(id: string | null) {
  return useQuery({
    queryKey: enableBankingKeys.connection(id ?? ''),
    queryFn: () => api.getEnableBankingConnection(id!),
    enabled: !!id,
    staleTime: 1000 * 60,
    retry: false,
  });
}

// --- Start a consent (new bank or reconnect); the caller navigates to `url` ---

export function useConnectEnableBanking() {
  return useMutation({
    mutationFn: (data: EnableBankingConnectRequest) => api.connectEnableBanking(data),
  });
}

// --- Map bank accounts to Bliss accounts ---

export function useMapEnableBankingConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    // Processing status (#100): the first sync is enqueued on success.
    meta: { activity: ['BANK_SYNC'] },
    mutationFn: ({ id, data }: { id: string; data: EnableBankingMapRequest }) =>
      api.mapEnableBankingConnection(id, data),
    onSuccess: (_result, { id }) => invalidateConnectionQueries(queryClient, id),
  });
}

// --- Sync now ---

export function useSyncEnableBankingConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { activity: ['BANK_SYNC'] },
    mutationFn: (id: string) => api.syncEnableBankingConnection(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: plaidItemKeys.all });
      queryClient.invalidateQueries({ queryKey: plaidItemKeys.syncLogs(id) });
    },
  });
}

// --- Disconnect (admin or the authorising user) ---

export function useDisconnectEnableBankingConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.disconnectEnableBankingConnection(id),
    onSuccess: (_result, id) => invalidateConnectionQueries(queryClient, id),
  });
}
