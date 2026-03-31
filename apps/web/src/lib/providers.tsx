import { ThemeProvider } from "./theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../contexts/AuthContext";
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { OnboardingProvider } from "./onboarding-context";

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
persistQueryClient({
  queryClient,
  persister: storagePersister,
  // Only persist metadata and accounts queries
  dehydrateOptions: {
    shouldDehydrateQuery: query =>
      query.queryKey[0] === 'metadata' || query.queryKey[0] === 'accounts',
  },
});

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
