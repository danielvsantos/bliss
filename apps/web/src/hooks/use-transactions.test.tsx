import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { useTransactions } from './use-transactions';
import React from 'react';

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useTransactions', () => {
  it('fetches transactions without filters correctly', async () => {
    let capturedUrl = '';
    
    server.use(
      http.get('/api/transactions', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          transactions: [{ id: 1, amount: 100 }],
          total: 1,
          page: 1,
          limit: 50,
          totalPages: 1
        });
      })
    );

    const { result } = renderHook(() => useTransactions(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.transactions).toHaveLength(1);
    
    // Check that no params were appended unexpectedly
    const url = new URL(capturedUrl);
    expect(url.searchParams.toString()).toBe('');
  });

  it('passes filters as query parameters correctly', async () => {
    let capturedUrl = '';
    
    server.use(
      http.get('/api/transactions', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({});
      })
    );

    const { result } = renderHook(() => useTransactions({ 
      startDate: '2023-01-01', 
      type: 'Income',
      limit: 25
    }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('startDate')).toBe('2023-01-01');
    expect(url.searchParams.get('type')).toBe('Income');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('omits type filter if type is "all"', async () => {
    let capturedUrl = '';
    
    server.use(
      http.get('/api/transactions', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({});
      })
    );

    const { result } = renderHook(() => useTransactions({ 
      type: 'all',
      accountId: 5
    }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('type')).toBeNull(); // Should be omitted
    expect(url.searchParams.get('accountId')).toBe('5');
  });
});
