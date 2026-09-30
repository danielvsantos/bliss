import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  CreateApiKeyRequest,
  CreateIntegrationRequest,
} from '@/types/integrations';

/**
 * Integrations & API tokens (#84) — Settings → Integrations (admin only).
 *
 * The create mutations resolve with the one-time plaintext `token`. It is
 * never written to the query cache: the list query only ever holds metadata.
 */

export const INTEGRATIONS_QUERY_KEY = ['integrations'] as const;

export function useIntegrations(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: INTEGRATIONS_QUERY_KEY,
    queryFn: async () => (await api.getIntegrations()).integrations,
    enabled: opts?.enabled ?? true,
    staleTime: 30_000,
  });
}

function useInvalidateIntegrations() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY });
}

export function useCreateIntegration() {
  const invalidate = useInvalidateIntegrations();
  return useMutation({
    mutationFn: (body: CreateIntegrationRequest) => api.createIntegration(body),
    onSuccess: () => invalidate(),
  });
}

export function useRenameIntegration() {
  const invalidate = useInvalidateIntegrations();
  return useMutation({
    mutationFn: ({ id, name, description }: { id: string; name?: string; description?: string | null }) =>
      api.updateIntegration(id, { name, description }),
    onSuccess: () => invalidate(),
  });
}

export function useRevokeIntegration() {
  const invalidate = useInvalidateIntegrations();
  return useMutation({
    mutationFn: (id: string) => api.revokeIntegration(id),
    onSuccess: () => invalidate(),
  });
}

export function useAddApiKey() {
  const invalidate = useInvalidateIntegrations();
  return useMutation({
    mutationFn: ({ integrationId, ...body }: CreateApiKeyRequest & { integrationId: string }) =>
      api.createApiKey(integrationId, body),
    onSuccess: () => invalidate(),
  });
}

export function useRevokeApiKey() {
  const invalidate = useInvalidateIntegrations();
  return useMutation({
    mutationFn: ({ integrationId, keyId }: { integrationId: string; keyId: string }) =>
      api.revokeApiKey(integrationId, keyId),
    onSuccess: () => invalidate(),
  });
}
