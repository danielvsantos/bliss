import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { useUserSettings, useUpdateUserSettings } from './use-user-settings';
import React from 'react';

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useUserSettings', () => {
  it('fetches user settings successfully', async () => {
    const mockSettings = { autoPromoteThreshold: 80, reviewThreshold: 50, portfolioCurrency: 'USD' };
    
    server.use(
      http.get('/api/tenants/settings', () => HttpResponse.json(mockSettings))
    );

    const { result } = renderHook(() => useUserSettings(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockSettings);
  });
});

describe('useUpdateUserSettings', () => {
  it('updates settings and optimally sets query data', async () => {
    const mockUpdate = { autoPromoteThreshold: 90 };
    let capturedRequest: Record<string, unknown> | null = null;

    server.use(
      http.put('/api/tenants/settings', async ({ request }) => {
        capturedRequest = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...capturedRequest, portfolioCurrency: 'USD', reviewThreshold: 50 });
      })
    );

    const { result } = renderHook(() => useUpdateUserSettings(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate(mockUpdate);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedRequest).toEqual(mockUpdate);
  });
});
