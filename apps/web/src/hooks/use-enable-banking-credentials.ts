import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { enableBankingKeys } from '@/hooks/use-enable-banking';
import { plaidItemKeys } from '@/hooks/use-plaid-actions';
import type { EnableBankingCredentialsRequest, EnableBankingCredentialsView } from '@/types/api';

/**
 * The tenant's own Enable Banking app (#148) — Settings → Bank sync, admins only.
 *
 * The private key is write-only: it travels in the save request and nowhere
 * else. The save mutation is never cached (`gcTime: 0`) so its variables do
 * not outlive the request; the query only ever holds metadata.
 */

export const enableBankingCredentialKeys = {
  all: [...enableBankingKeys.all, 'credentials'] as const,
};

export function useEnableBankingCredentials(enabled = true) {
  return useQuery({
    queryKey: enableBankingCredentialKeys.all,
    queryFn: () => api.getEnableBankingCredentials(),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** Everything a credential change affects: the tab, the status, connection cards and notifications. */
function useOnCredentialsChanged() {
  const queryClient = useQueryClient();
  return (view?: EnableBankingCredentialsView) => {
    if (view) queryClient.setQueryData(enableBankingCredentialKeys.all, view);
    queryClient.invalidateQueries({ queryKey: enableBankingKeys.all });
    queryClient.invalidateQueries({ queryKey: plaidItemKeys.all });
    queryClient.invalidateQueries({ queryKey: ['notification-summary'] });
  };
}

export function useSaveEnableBankingCredentials() {
  const onChanged = useOnCredentialsChanged();
  return useMutation({
    mutationFn: (data: EnableBankingCredentialsRequest) => api.saveEnableBankingCredentials(data),
    gcTime: 0,
    onSuccess: (view) => onChanged(view),
  });
}

export function useRemoveEnableBankingCredentials() {
  const onChanged = useOnCredentialsChanged();
  return useMutation({
    mutationFn: (confirm: boolean) => api.removeEnableBankingCredentials(confirm),
    onSuccess: () => onChanged(),
  });
}

export function useVerifyEnableBankingCredentials() {
  const onChanged = useOnCredentialsChanged();
  return useMutation({
    mutationFn: () => api.verifyEnableBankingCredentials(),
    onSuccess: (view) => onChanged(view),
  });
}
