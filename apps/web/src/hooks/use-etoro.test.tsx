import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import {
  etoroError,
  etoroKeys,
  useConnectEtoro,
  useConvertToCopyTrading,
  useEtoroConnections,
  useSyncEtoroConnection,
} from './use-etoro';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

const CONNECTION = {
  id: 'c1', etoroUsername: 'BlissUser', accountId: 3, account: { id: 3, name: 'eToro' }, keyLast4: '1234',
  scopes: ['trade.real:read'], status: 'ACTIVE', errorCode: null, connectedAt: '2026-10-20T00:00:00Z',
  lastSyncAt: null, lastSyncStatus: null, lastSyncError: null, copies: [],
};

describe('use-etoro (#143)', () => {
  it('lists connections', async () => {
    server.use(http.get('/api/etoro/connections', () => HttpResponse.json({ connections: [CONNECTION] })));
    const { wrapper } = setup();
    const { result } = renderHook(() => useEtoroConnections(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([CONNECTION]);
  });

  it('connect sends the keys once, refreshes portfolio views and keeps no variables', async () => {
    let body: unknown = null;
    server.use(http.post('/api/etoro/connections', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ connection: CONNECTION, copies: [] }, { status: 201 });
    }));
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useConnectEtoro(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ apiKey: 'pub', userKey: 'secret', accountId: 3 });
    });
    expect(body).toEqual({ apiKey: 'pub', userKey: 'secret', accountId: 3 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: etoroKeys.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['portfolio-items'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['equity-analysis'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['portfolio-assets'] });
    act(() => result.current.reset());
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
  });

  it('exposes the cooldown of "Sync now"', async () => {
    server.use(http.post('/api/etoro/connections/c1/sync', () =>
      HttpResponse.json({ error: 'x', code: 'COOLDOWN', retryAfter: 600 }, { status: 429 })));
    const { wrapper } = setup();
    const { result } = renderHook(() => useSyncEtoroConnection(), { wrapper });
    let error: unknown;
    await act(async () => {
      try { await result.current.mutateAsync('c1'); } catch (e) { error = e; }
    });
    expect(etoroError(error)).toEqual({ status: 429, body: { error: 'x', code: 'COOLDOWN', retryAfter: 600 } });
  });

  it('convert posts the holding and the username', async () => {
    let body: unknown = null;
    server.use(http.post('/api/etoro/convert-holding', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ portfolioItemId: 5, symbol: 'topinvestor', categoryId: 9, transactionsMoved: 2 });
    }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useConvertToCopyTrading(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ portfolioItemId: 5, etoroUsername: 'topinvestor' });
    });
    expect(body).toEqual({ portfolioItemId: 5, etoroUsername: 'topinvestor' });
  });
});
