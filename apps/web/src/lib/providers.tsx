import { ThemeProvider } from "./theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../contexts/AuthContext";
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { OnboardingProvider } from "./onboarding-context";
import { shouldPersistPortfolioQuery, markPortfolioQueriesStale } from "./query-config";

// Create storage persister
const storagePersister = createSyncStoragePersister({
  storage: window.localStorage,
});

// Create client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
    },
  },
});

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

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <OnboardingProvider>
            {children}
          </OnboardingProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
