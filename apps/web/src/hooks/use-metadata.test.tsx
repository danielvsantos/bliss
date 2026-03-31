import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { useAccounts, useCategories } from './use-metadata';
import React from 'react';

// Setup isolated QueryClient for testing to avoid cache pollution
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, // Turn off retries for faster test failure
      },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useAccounts', () => {
  it('starts in a loading state', () => {
    const { result } = renderHook(() => useAccounts(), {
      wrapper: createWrapper(),
    });
    expect(result.current.isLoading).toBe(true);
  });

  it('resolves with the accounts array from the API', async () => {
    const mockAccounts = [
      { id: 1, name: 'Checking Account', bankId: 1, currencyCode: 'USD', countryId: 'US' }
    ];

    server.use(
      http.get('/api/accounts', () =>
        HttpResponse.json({ accounts: mockAccounts, total: 1 })
      )
    );

    const { result } = renderHook(() => useAccounts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(mockAccounts);
    expect(result.current.isSuccess).toBe(true);
  });

  it('handles server errors correctly', async () => {
    server.use(
      http.get('/api/accounts', () =>
        new HttpResponse(null, { status: 500 })
      )
    );

    const { result } = renderHook(() => useAccounts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeDefined();
  });
});

describe('useCategories', () => {
  it('starts in a loading state', () => {
    const { result } = renderHook(() => useCategories(), {
      wrapper: createWrapper(),
    });
    expect(result.current.isLoading).toBe(true);
  });

  it('resolves with the categories array from the API', async () => {
    const mockCategories = [
      { id: 1, name: 'Groceries', group: 'Food', type: 'Expense' }
    ];

    server.use(
      http.get('/api/categories', () =>
        HttpResponse.json({ categories: mockCategories, total: 1 })
      )
    );

    const { result } = renderHook(() => useCategories(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(mockCategories);
    expect(result.current.isSuccess).toBe(true);
  });
});
