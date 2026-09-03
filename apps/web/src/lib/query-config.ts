import type { QueryClient } from '@tanstack/react-query';

/**
 * Shared TanStack Query tuning for the portfolio endpoints.
 *
 * The dashboard and Portfolio Holdings pages mount several portfolio hooks that
 * hit endpoints which recompute live valuations on every request (fanning out to
 * the metered Twelve Data API). Without a freshness window every mount /
 * navigation triggers a full recompute. These constants apply a 3-minute
 * `staleTime` and persist the last-known values to `localStorage` so repeat
 * views and hard reloads paint instantly instead of re-fetching.
 *
 * This is a leaf module: it imports only a type from `@tanstack/react-query` so
 * it can be shared by `lib/providers.tsx` and the hook files without an import
 * cycle.
 */

/** Freshness window for portfolio queries — 3 minutes. */
export const PORTFOLIO_STALE_TIME_MS = 180_000;

/**
 * Skip persisting a single portfolio query whose serialized payload exceeds this
 * size (~1 MB). Large holdings payloads would otherwise bloat `localStorage`;
 * such a query simply falls back to fetch-on-load.
 */
export const PORTFOLIO_PERSIST_MAX_BYTES = 1_000_000;

/**
 * Query-key roots for the four portfolio queries. Keep these in sync with the
 * `*_QUERY_KEY` constants exported from the hook files:
 *   - `PORTFOLIO_ITEMS_QUERY_KEY`   → `hooks/use-portfolio-items.ts`
 *   - `HOLDINGS_QUERY_KEY`          → `hooks/use-portfolio-holdings.ts`
 *   - `HISTORY_QUERY_KEY`          → `hooks/use-portfolio-history.ts`
 *   - `EQUITY_ANALYSIS_QUERY_KEY`   → `hooks/use-equity-analysis.ts`
 */
export const PORTFOLIO_QUERY_KEY_ROOTS = [
  'portfolio-items',
  'portfolio-holdings',
  'portfolio-history',
  'equity-analysis',
] as const;

/** Minimal shape of a TanStack Query needed by {@link shouldPersistPortfolioQuery}. */
type PersistCandidateQuery = {
  queryKey: readonly unknown[];
  state: { status: string; data: unknown };
};

/**
 * True when a portfolio payload actually carries holdings/history/groups.
 *
 * An empty response can legitimately occur transiently during early app boot
 * (before the tenant/currency context is ready). Persisting that would pin a
 * "net worth 0" value into `localStorage` that then paints on every reload with
 * no revalidation until `staleTime` elapses — the exact "stuck at 0" symptom.
 * A genuinely empty portfolio simply fetches-on-load instead (cheap).
 */
function hasPortfolioContent(data: unknown): boolean {
  if (data == null) return false;
  if (Array.isArray(data)) return data.length > 0; // holdings response
  if (typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const rows = d.items ?? d.history ?? d.groups;
    if (Array.isArray(rows)) return rows.length > 0;
    return true; // unrecognised object shape — do not block persistence
  }
  return true;
}

/**
 * Predicate for the persister's `shouldDehydrateQuery`: persist a portfolio
 * query only when it is one of the whitelisted roots, has successfully resolved,
 * carries non-empty content, and its serialized payload is within the size cap.
 */
export function shouldPersistPortfolioQuery(query: PersistCandidateQuery): boolean {
  const root = query.queryKey[0];
  if (typeof root !== 'string') return false;
  if (!(PORTFOLIO_QUERY_KEY_ROOTS as readonly string[]).includes(root)) return false;
  if (query.state.status !== 'success') return false;
  if (!hasPortfolioContent(query.state.data)) return false;

  try {
    const serialized = JSON.stringify(query.state.data ?? null);
    return serialized.length <= PORTFOLIO_PERSIST_MAX_BYTES;
  } catch {
    // Non-serializable payload — do not persist it.
    return false;
  }
}

/**
 * Invalidate every portfolio query root so cached views refetch immediately
 * rather than waiting out {@link PORTFOLIO_STALE_TIME_MS}. Call this from
 * mutation success handlers that change holdings composition or value.
 */
export function invalidatePortfolioQueries(queryClient: QueryClient): void {
  for (const root of PORTFOLIO_QUERY_KEY_ROOTS) {
    queryClient.invalidateQueries({ queryKey: [root] });
  }
}

/**
 * Mark the persisted portfolio queries stale **without** firing a request now
 * (`refetchType: 'none'`). Call this once, right after the query client is
 * rehydrated from `localStorage` on a cold page load: the cached values paint
 * instantly, then the next mount triggers exactly one background refresh
 * (with the inline spinner). In-app navigation afterwards is governed normally
 * by {@link PORTFOLIO_STALE_TIME_MS}, so this does not cause extra refetches
 * when moving between pages within the freshness window.
 */
export function markPortfolioQueriesStale(queryClient: QueryClient): void {
  for (const root of PORTFOLIO_QUERY_KEY_ROOTS) {
    queryClient.invalidateQueries({ queryKey: [root], refetchType: 'none' });
  }
}
