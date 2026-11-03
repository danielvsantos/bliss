import { MutationCache, QueryClient } from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
  type PersistedClient,
  type Persister,
} from '@tanstack/react-query-persist-client';
import { shouldPersistPortfolioQuery, markPortfolioQueriesStale } from "./query-config";
import { markActivityPending, setActivityQueryClient } from "./activity-pending";
import { clearTenantMeta } from "@/utils/tenantMetaStorage";
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
 *
 * Shared-device rule (#78 R4): nothing is restored from localStorage until the
 * signed-in user is known. `activatePersistedCache(owner)` restores only the
 * cache written by that same user + tenant, and wipes anyone else's (and their
 * tenantMeta) first. Sign-out and session expiry call
 * `clearPersistedQueryCache()`.
 */

export const PERSIST_KEY = 'REACT_QUERY_OFFLINE_CACHE';
export const CACHE_OWNER_KEY = 'bliss.cacheOwner';
const PERSIST_MAX_AGE_MS = 1000 * 60 * 60 * 24; // 24 hours
const PERSIST_THROTTLE_MS = 1000;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeGet(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Storage full or unavailable: the cache just isn't persisted.
  }
}

function safeRemove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Storage unavailable: nothing was persisted there.
  }
}

/**
 * Bumped by every clear. A throttled write that was queued for an earlier
 * generation is dropped, so a pending write can never put the previous user's
 * data back after sign-out (createSyncStoragePersister's trailing write would).
 */
let generation = 0;

function createOwnedPersister(): Persister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { client: PersistedClient; gen: number } | null = null;
  return {
    persistClient(client) {
      pending = { client, gen: generation };
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const job = pending;
        pending = null;
        if (job && job.gen === generation) safeSet(PERSIST_KEY, JSON.stringify(job.client));
      }, PERSIST_THROTTLE_MS);
    },
    restoreClient() {
      const raw = safeGet(PERSIST_KEY);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as PersistedClient;
      } catch {
        return undefined;
      }
    },
    removeClient() {
      pending = null;
      safeRemove(PERSIST_KEY);
    },
  };
}

const storagePersister = createOwnedPersister();

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

// Persist metadata, accounts, and the portfolio queries so cached values
// survive a hard reload and paint before revalidation. Portfolio queries are
// gated on success status + non-empty content + a payload-size cap
// (see query-config.ts).
const dehydrateOptions = {
  shouldDehydrateQuery: (query: Parameters<typeof shouldPersistPortfolioQuery>[0]) =>
    query.queryKey[0] === 'metadata' ||
    query.queryKey[0] === 'accounts' ||
    shouldPersistPortfolioQuery(query),
};

let activeOwner: string | null = null;
let unsubscribe: (() => void) | null = null;

/** `"<userId>:<tenantId>"` — whose data the persisted cache holds. */
export function cacheOwnerFor(user: {
  id: string | number;
  tenantId?: string | number | null;
  tenant?: { id?: string | number } | null;
}): string {
  return `${user.id}:${user.tenant?.id ?? user.tenantId ?? ''}`;
}

/**
 * Starts persistence for the signed-in `owner` (idempotent). When the cache on
 * disk was written by the same owner it is restored first; otherwise it is
 * deleted together with tenantMeta and every in-memory query. Must complete
 * before the user is exposed to the app, so a protected page never paints
 * another user's figures.
 */
export async function activatePersistedCache(owner: string): Promise<void> {
  if (activeOwner === owner && unsubscribe) return;
  if (activeOwner !== null && activeOwner !== owner) clearPersistedQueryCache();

  if (safeGet(CACHE_OWNER_KEY) === owner) {
    try {
      await persistQueryClientRestore({ queryClient, persister: storagePersister, maxAge: PERSIST_MAX_AGE_MS });
      // Once the cache is rehydrated on a cold page load, mark the portfolio
      // queries stale (without an immediate request) so the first mount does
      // exactly one background refresh — the cached value paints instantly,
      // then updates.
      markPortfolioQueriesStale(queryClient);
    } catch {
      // Nothing persisted / restore failed — nothing to revalidate.
    }
  } else {
    generation += 1;
    queryClient.clear();
    storagePersister.removeClient();
    clearTenantMeta();
  }

  safeSet(CACHE_OWNER_KEY, owner);
  unsubscribe?.();
  unsubscribe = persistQueryClientSubscribe({ queryClient, persister: storagePersister, dehydrateOptions });
  activeOwner = owner;
}

/**
 * Logout hygiene (#155, #78 R4): drops every cached query, the persisted copy
 * in localStorage, tenantMeta and the owner marker, and stops persisting until
 * the next `activatePersistedCache`. Called on sign-out, on session expiry and
 * when a session check finds no user.
 */
export function clearPersistedQueryCache(): void {
  generation += 1;
  unsubscribe?.();
  unsubscribe = null;
  activeOwner = null;
  queryClient.clear();
  storagePersister.removeClient();
  try {
    clearTenantMeta();
  } catch {
    // Storage unavailable: nothing was stored there.
  }
  safeRemove(CACHE_OWNER_KEY);
}
