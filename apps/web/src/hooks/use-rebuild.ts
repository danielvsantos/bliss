import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import type {
  RebuildStatusResponse,
  RebuildTriggerRequest,
  RebuildTriggerResponse,
} from '@/types/api';

export const REBUILD_STATUS_QUERY_KEY = ['admin', 'rebuild', 'status'] as const;

/**
 * Fetches current rebuild state for the tenant: per-scope single-flight
 * lock info, currently-running rebuild jobs (if any), and the last 20
 * completed/failed rebuilds.
 *
 * Polls every 5s when the window is focused. Returning `isPolling: true`
 * from `useRebuildStatus` is left to the caller — most UIs will want to
 * stop polling when no rebuild is active, or rely on the built-in
 * refetchIntervalInBackground: false default.
 */
export function useRebuildStatus(opts?: { pollMs?: number; enabled?: boolean }) {
  const { pollMs = 5000, enabled = true } = opts ?? {};
  return useQuery<RebuildStatusResponse>({
    queryKey: REBUILD_STATUS_QUERY_KEY,
    queryFn: () => api.getRebuildStatus(),
    enabled,
    refetchInterval: pollMs,
    // Keep polling even when a scope is locked — the TTL countdown is what
    // powers the "next available in X min" UX.
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

/**
 * Triggers an admin rebuild. The backend acquires a per-(tenant, scope)
 * single-flight lock via Redis; if it's already held, this mutation
 * rejects with HTTP 409 and the response body contains `ttlSeconds` so
 * the caller can display an ETA.
 *
 * On success, invalidates the rebuild status query so the UI shows the
 * newly-enqueued job immediately (the 5s poll will keep it fresh).
 */
export function useTriggerRebuild() {
  const qc = useQueryClient();
  return useMutation<RebuildTriggerResponse, Error, RebuildTriggerRequest>({
    mutationFn: (body) => api.triggerRebuild(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: REBUILD_STATUS_QUERY_KEY });
    },
  });
}
