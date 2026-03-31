import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Country, Currency, Bank, Category, Account } from '@/types/api';

// Types for your metadata
export interface Metadata {
  countries: Country[];
  currencies: Currency[];
  banks: Bank[];
  categories: Category[];
  accounts: Account[]; // Added accounts
  userPreferences?: {
    defaultCurrency: string;
    defaultCountry: string;
    theme: 'light' | 'dark' | 'system';
  };
}

// Metadata query keys
export const metadataKeys = {
  all: ['metadata'] as const,
  countries: () => [...metadataKeys.all, 'countries'] as const,
  currencies: () => [...metadataKeys.all, 'currencies'] as const,
  banks: () => [...metadataKeys.all, 'banks'] as const,
  categories: () => [...metadataKeys.all, 'categories'] as const,
  accounts: () => [...metadataKeys.all, 'accounts'] as const, // Added accounts key
  userPreferences: () => [...metadataKeys.all, 'userPreferences'] as const,
};

// Hook for fetching all metadata
export function useMetadata() {
  return useQuery({
    queryKey: metadataKeys.all,
    queryFn: async (): Promise<Metadata> => {
      console.log('🔄 Fetching all metadata');
      // The `api.getUserPreferences()` call was removed as it does not exist.
      // A proper user preferences store should be implemented separately.
      const [countries, currencies, banks, categoriesResponse, accountsResponse] = await Promise.all([
        api.getCountries(),
        api.getCurrencies(),
        api.getBanks(),
        api.getCategories({ limit: 1000 }),
        api.getAccounts({ limit: 1000 }), // Fetch accounts
      ]);

      // TODO: Replace this with a real user preferences implementation
      const userPreferences = {
        defaultCurrency: 'USD',
        defaultCountry: 'US',
        theme: 'system' as 'light' | 'dark' | 'system',
      }

      // Add default values required by the type
      const enhancedCountries = countries.map(c => ({
        ...c,
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));

      const enhancedCurrencies = currencies.map(c => ({
        ...c,
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));

      const enhancedBanks = banks.map(b => ({
        ...b,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));

      return {
        countries: enhancedCountries,
        currencies: enhancedCurrencies,
        banks: enhancedBanks,
        categories: categoriesResponse.categories,
        accounts: accountsResponse.accounts, // Add accounts to the return object
        userPreferences,
      };
    },
    staleTime: 1000 * 60 * 5, // Fetch fresh metadata every 5 minutes (Balanced)
    gcTime: 1000 * 60 * 60 * 24, // Keep in cache for 24 hours
  });
}

// Individual hooks for specific metadata

export function useAccounts() {
  return useQuery({
    queryKey: metadataKeys.accounts(),
    queryFn: async () => {
      const response = await api.getAccounts({ limit: 1000 });
      return response.accounts;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useCategories() {
  return useQuery({
    queryKey: metadataKeys.categories(),
    queryFn: async () => {
      const response = await api.getCategories({ limit: 1000 });
      return response.categories;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useCountries() {
  return useQuery({
    queryKey: metadataKeys.countries(),
    queryFn: async () => {
      console.log('🔄 Fetching countries');
      const data = await api.getCountries();
      const enhancedData = data.map(c => ({
        ...c,
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));
      console.log('✅ Countries fetched:', enhancedData.length);
      return enhancedData;
    },
    staleTime: 1000 * 60 * 60 * 24, // Consider countries fresh for 24 hours
  });
}

export function useCurrencies() {
  return useQuery({
    queryKey: metadataKeys.currencies(),
    queryFn: async () => {
      console.log('🔄 Fetching currencies');
      const data = await api.getCurrencies();
      const enhancedData = data.map(c => ({
        ...c,
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));
      console.log('✅ Currencies fetched:', enhancedData.length);
      return enhancedData;
    },
    staleTime: 1000 * 60 * 60 * 24, // Consider currencies fresh for 24 hours
  });
}

export function useBanks() {
  return useQuery({
    queryKey: metadataKeys.banks(),
    queryFn: async () => {
      console.log('🔄 Fetching banks');
      const data = await api.getBanks();
      const enhancedData = data.map(b => ({
        ...b,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));
      console.log('✅ Banks fetched:', enhancedData.length);
      return enhancedData;
    },
    staleTime: 1000 * 60 * 60, // Consider banks fresh for 1 hour
  });
}

export function useUserPreferences() {
  return useQuery({
    queryKey: metadataKeys.userPreferences(),
    queryFn: async () => {
      // This is a placeholder since the API endpoint doesn't exist yet.
      // Replace with a real API call when available.
      return {
        defaultCurrency: 'USD',
        defaultCountry: 'US',
        theme: 'system' as 'light' | 'dark' | 'system',
      };
    },
    staleTime: 1000 * 60 * 5, // Consider preferences fresh for 5 minutes
  });
} 