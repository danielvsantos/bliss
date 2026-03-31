import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Transaction } from '@/types/api';

export const TRANSACTIONS_QUERY_KEY = 'transactions';

// Define the types directly in the hook file
export interface Paginated<T> {
  transactions: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type TransactionFilters = {
    startDate?: string;
    endDate?: string;
    accountId?: number;
    categoryId?: number;
    type?: 'all' | 'Income' | 'Expense' | 'Transfer' | 'Investment';
    searchQuery?: string;
    limit?: number;
    page?: number;
    month?: number;
    quarter?: string;
    year?: number;
    categoryGroup?: string;
    tag?: string;
    sortField?: string;
    sortDirection?: 'asc' | 'desc';
    group?: string;
    currencyCode?: string;
};

export const useTransactions = (filters: TransactionFilters = {}) => {
  return useQuery({
    queryKey: [TRANSACTIONS_QUERY_KEY, filters],
    queryFn: () => {
      const { type, ...rest } = filters;
      const apiFilters: any = { ...rest };
      if (type && type !== 'all') {
        apiFilters.type = type;
      }
      return api.getTransactions(apiFilters);
    },
  });
}; 