import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { enableBankingKeys } from './use-enable-banking';
import { plaidItemKeys } from './use-plaid-actions';
import {
  enableBankingCredentialKeys,
  useEnableBankingCredentials,
  useRemoveEnableBankingCredentials,
  useSaveEnableBankingCredentials,
} from './use-enable-banking-credentials';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

const VIEW = {
  configured: true,
  callbackUrl: 'https://api.test/api/enablebanking/callback',
  credential: { appId: 'a', keyFingerprint: 'SHA256:x', keyBits: 2048, status: 'VERIFIED', lastValidatedAt: null, callbackRegistered: null, updatedAt: '2026-10-18T00:00:00Z' },
  usage: { activeConnections: 0, pausedConnections: 0, linkedAccounts: 0, limit: 5 },
  history: [],
};

describe('use-enable-banking-credentials (#148)', () => {
  it('loads the view (MSW default: not configured)', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useEnableBankingCredentials(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ configured: false, credential: null });
  });

  it('save stores the returned view, invalidates status, bank items and notifications, and keeps no variables', async () => {
    server.use(http.put('/api/enablebanking/credentials', () => HttpResponse.json(VIEW, { status: 201 })));
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSaveEnableBankingCredentials(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ appId: 'a', privateKey: '-----BEGIN PRIVATE KEY-----' });
    });
    expect(queryClient.getQueryData(enableBankingCredentialKeys.all)).toEqual(VIEW);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: enableBankingKeys.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: plaidItemKeys.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notification-summary'] });
    act(() => result.current.reset());
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
  });

  it('remove sends confirm only when asked', async () => {
    const urls: string[] = [];
    server.use(http.delete('/api/enablebanking/credentials', ({ request }) => {
      urls.push(new URL(request.url).search);
      return new HttpResponse(null, { status: 204 });
    }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useRemoveEnableBankingCredentials(), { wrapper });
    await act(async () => { await result.current.mutateAsync(false); });
    await act(async () => { await result.current.mutateAsync(true); });
    expect(urls).toEqual(['', '?confirm=true']);
  });
});
