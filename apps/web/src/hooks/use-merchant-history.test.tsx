import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { useMerchantHistory } from './use-merchant-history';
import React from 'react';

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useMerchantHistory', () => {
  it('does not fetch if description is missing', () => {
    const { result } = renderHook(() => useMerchantHistory(''), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches merchant history successfully query by description', async () => {
    const mockHistory = [
      { id: 1, transaction_date: '2023-01-01', credit: 100, currency: 'USD' }
    ];
    let capturedDescription = '';

    server.use(
      http.get('/api/transactions/merchant-history', ({ request }) => {
        const url = new URL(request.url);
        capturedDescription = url.searchParams.get('description') || '';
        return HttpResponse.json(mockHistory);
      })
    );

    const { result } = renderHook(() => useMerchantHistory('Target'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockHistory);
    // Ensure the description parameter was sent to the server
    expect(capturedDescription).toBe('Target');
  });
});
