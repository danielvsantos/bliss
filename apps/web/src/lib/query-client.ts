import { MutationCache, QueryClient } from "@tanstack/react-query";
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { shouldPersistPortfolioQuery, markPortfolioQueriesStale } from "./query-config";
import { markActivityPending, setActivityQueryClient } from "./activity-pending";
import type { ActivityType } from "@/types/activity";

// `meta.activity` on a mutation: the processing-status types its success
// starts in the background, shown as "Queued" right away (#100).
declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: { activity?: ActivityType[] };
  }
}

/**
 * The app's single QueryClient and its localStorage persistence. Lives outside
 * providers.tsx so AuthContext can clear it on logout without an import cycle.
 */

// Create storage persister
const storagePersister = createSyncStoragePersister({
  storage: window.localStorage,
});

// Create client
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
    },
  },
  mutationCache: new MutationCache({
    onSuccess: (_data, _variables, _context, mutation) => {
      const types = mutation.options.meta?.activity;
      if (types?.length) markActivityPending(types);
    },
  }),
});
setActivityQueryClient(queryClient);

// Initialize persistence
const [, persistRestorePromise] = persistQueryClient({
  queryClient,
  persister: storagePersister,
  // Persist metadata, accounts, and the portfolio queries so cached values
  // survive a hard reload and paint before revalidation. Portfolio queries are
  // gated on success status + non-empty content + a payload-size cap
  // (see query-config.ts).
  dehydrateOptions: {
    shouldDehydrateQuery: query =>
      query.queryKey[0] === 'metadata' ||
      query.queryKey[0] === 'accounts' ||
      shouldPersistPortfolioQuery(query),
  },
});

// Once the cache is rehydrated on a cold page load, mark the portfolio queries
// stale (without an immediate request) so the first mount does exactly one
// background refresh — the cached value paints instantly, then updates. This
// makes the "cold reload → background refresh" contract independent of how
// recently the value happened to be persisted.
persistRestorePromise
  .then(() => markPortfolioQueriesStale(queryClient))
  .catch(() => { /* nothing persisted / restore failed — nothing to revalidate */ });

/**
 * Logout hygiene (#155): drops every cached query and deletes the persisted
 * copy in localStorage, so no portfolio, account or metadata payload stays on
 * the device after sign-out. Called on explicit logout only — a session that
 * expires keeps the cache, which ages out on its 24 h gcTime (PRD D9).
 */
export function clearPersistedQueryCache(): void {
  queryClient.clear();
  try {
    storagePersister.removeClient();
  } catch {
    // Storage unavailable: nothing was persisted there.
  }
}
