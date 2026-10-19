import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import {
  enableBankingKeys,
  useEnableBankingEnabled,
  useEnableBankingStatus,
  useMapEnableBankingConnection,
  useSyncEnableBankingConnection,
} from './use-enable-banking';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('use-enable-banking (#132)', () => {
  it('status defaults to disabled (MSW default) and is enabled when the API says so', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useEnableBankingStatus(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ enabled: false, configurable: false, pausedConnections: 0 });

    server.use(http.get('/api/enablebanking/status', () => HttpResponse.json({ enabled: true, configurable: true, pausedConnections: 0 })));
    const { wrapper: w2 } = setup();
    const { result: r2 } = renderHook(() => useEnableBankingEnabled(), { wrapper: w2 });
    await waitFor(() => expect(r2.current).toBe(true));
  });

  it('treats a failing status call as disabled', async () => {
    server.use(http.get('/api/enablebanking/status', () => HttpResponse.json({}, { status: 500 })));
    const { wrapper } = setup();
    const { result } = renderHook(() => useEnableBankingEnabled(), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(false);
  });

  it('mapping invalidates the connection, bank items and account queries', async () => {
    server.use(
      http.post('/api/enablebanking/connections/c1/map', () =>
        HttpResponse.json({ mapped: 1, created: 0, skipped: 0, switched: 0, active: true }),
      ),
    );
    const { queryClient, wrapper } = setup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useMapEnableBankingConnection(), { wrapper });

    result.current.mutate({ id: 'c1', data: { mappings: [{ ebAccountId: 'e1', accountId: 1 }] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(enableBankingKeys.connection('c1')));
    expect(keys).toContain(JSON.stringify(['plaid-items']));
    expect(keys).toContain(JSON.stringify(['account-list']));
    expect(keys).toContain(JSON.stringify(['metadata']));
  });

  it('sync surfaces the 429 body (code + resetsAt) to the caller', async () => {
    server.use(
      http.post('/api/enablebanking/connections/c1/sync', () =>
        HttpResponse.json({ code: 'SYNC_BUDGET_EXHAUSTED', resetsAt: '2026-10-12T00:00:00.000Z' }, { status: 429 }),
      ),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useSyncEnableBankingConnection(), { wrapper });

    result.current.mutate('c1');
    await waitFor(() => expect(result.current.isError).toBe(true));
    const err = result.current.error as unknown as { response: { status: number; data: { code: string; resetsAt: string } } };
    expect(err.response.status).toBe(429);
    expect(err.response.data).toEqual({ code: 'SYNC_BUDGET_EXHAUSTED', resetsAt: '2026-10-12T00:00:00.000Z' });
  });
});
