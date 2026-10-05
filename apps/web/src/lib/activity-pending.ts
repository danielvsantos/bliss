import type { QueryClient } from '@tanstack/react-query';
import type { ActivityType } from '@/types/activity';

/**
 * Optimistic "Queued" for processing status (#100, PRD R4.3).
 *
 * Right after a write that starts background work succeeds, the header chip
 * (and page banners) show the affected activity types as queued before the
 * first `/api/activity` poll answers. An entry is dropped once a poll that
 * completed well after it has had the chance to show the real state, or after
 * PENDING_GRACE_MS at most — whichever comes first.
 *
 * Writes go through `markActivityPending(types)`: called by the MutationCache
 * for mutations whose `meta.activity` lists types, and directly by the few
 * forms that call the API without a mutation (transactions, manual values).
 */

export const ACTIVITY_QUERY_KEY = ['activity'] as const;

/** Hard cap on how long an optimistic entry can stand without the server confirming it. */
export const PENDING_GRACE_MS = 20_000;
/**
 * A poll only clears an entry if it completed at least this long after the
 * write: a few routes emit their event without awaiting it, so the very first
 * poll can predate the queued job.
 */
export const PENDING_SETTLE_MS = 1_500;

export interface PendingActivity {
  types: ActivityType[];
  at: number;
}

let pending: PendingActivity[] = [];
const listeners = new Set<() => void>();
let queryClient: QueryClient | null = null;

function emit() {
  for (const l of listeners) l();
}

/** Called once by the app's QueryClient setup so a write triggers an immediate poll. */
export function setActivityQueryClient(client: QueryClient | null) {
  queryClient = client;
}

export function markActivityPending(types: ActivityType[]) {
  if (!Array.isArray(types) || types.length === 0) return;
  const entry = { types: [...types], at: Date.now() };
  pending = [...pending, entry];
  emit();
  // Drop it after the grace period even if no poll ever answers.
  setTimeout(() => {
    if (pending.includes(entry)) {
      pending = pending.filter((p) => p !== entry);
      emit();
    }
  }, PENDING_GRACE_MS);
  queryClient?.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
}

/** Drop entries a poll completed at `dataUpdatedAt` has had the chance to confirm. */
export function settlePendingActivity(dataUpdatedAt: number) {
  const next = pending.filter((p) => dataUpdatedAt < p.at + PENDING_SETTLE_MS);
  if (next.length !== pending.length) {
    pending = next;
    emit();
  }
}

export function subscribePendingActivity(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPendingActivity(): PendingActivity[] {
  return pending;
}

/** Tests only. */
export function __resetPendingActivity() {
  pending = [];
  queryClient = null;
  emit();
}
