import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import {
  INTEGRATIONS_QUERY_KEY,
  useAddApiKey,
  useCreateIntegration,
  useIntegrations,
  useRenameIntegration,
  useRevokeApiKey,
  useRevokeIntegration,
} from './use-integrations';
import type { CreateIntegrationResponse } from '@/types/integrations';

const INTEGRATION = {
  id: 'int-1',
  name: 'Claude agent',
  description: null,
  accessLevel: 'READ_ONLY',
  createdByUserId: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  revokedAt: null,
  status: 'active',
  keyCount: 1,
  activeKeyCount: 1,
  lastUsedAt: null,
  keys: [],
};

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('useIntegrations', () => {
  it('returns the integrations list', async () => {
    server.use(http.get('/api/integrations', () => HttpResponse.json({ integrations: [INTEGRATION] })));
    const { wrapper } = setup();
    const { result } = renderHook(() => useIntegrations(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].name).toBe('Claude agent');
  });

  it('can be disabled', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useIntegrations({ enabled: false }), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('integration mutations', () => {
  it('create returns the one-time token and invalidates the list without caching the token', async () => {
    let body: unknown;
    server.use(
      http.post('/api/integrations', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ integration: INTEGRATION, apiKey: {}, token: 'bliss_ABCDEFGH_secret' }, { status: 201 });
      }),
    );
    const { wrapper, queryClient } = setup();
    queryClient.setQueryData(INTEGRATIONS_QUERY_KEY, []);
    const { result } = renderHook(() => useCreateIntegration(), { wrapper });

    let response: CreateIntegrationResponse | undefined;
    await act(async () => {
      response = await result.current.mutateAsync({
        name: 'Claude agent', accessLevel: 'READ_ONLY', key: { expiresInDays: 90 },
      });
    });

    expect(body).toEqual({ name: 'Claude agent', accessLevel: 'READ_ONLY', key: { expiresInDays: 90 } });
    expect(response?.token).toBe('bliss_ABCDEFGH_secret');
    expect(queryClient.getQueryState(INTEGRATIONS_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('secret');
  });

  async function expectCallAndInvalidate(
    handler: Parameters<typeof server.use>[0],
    run: (wrapper: ({ children }: { children: React.ReactNode }) => React.JSX.Element) => Promise<void>,
    wasCalled: () => boolean,
  ) {
    server.use(handler);
    const { wrapper, queryClient } = setup();
    queryClient.setQueryData(INTEGRATIONS_QUERY_KEY, []);
    await run(wrapper);
    expect(wasCalled()).toBe(true);
    expect(queryClient.getQueryState(INTEGRATIONS_QUERY_KEY)?.isInvalidated).toBe(true);
  }

  it('rename PATCHes the integration and invalidates the list', async () => {
    let called = false;
    await expectCallAndInvalidate(
      http.patch('/api/integrations/int-1', () => { called = true; return HttpResponse.json({}); }),
      async (wrapper) => {
        const { result } = renderHook(() => useRenameIntegration(), { wrapper });
        await act(async () => { await result.current.mutateAsync({ id: 'int-1', name: 'New' }); });
      },
      () => called,
    );
  });

  it('revoke DELETEs the integration and invalidates the list', async () => {
    let called = false;
    await expectCallAndInvalidate(
      http.delete('/api/integrations/int-1', () => { called = true; return HttpResponse.json({}); }),
      async (wrapper) => {
        const { result } = renderHook(() => useRevokeIntegration(), { wrapper });
        await act(async () => { await result.current.mutateAsync('int-1'); });
      },
      () => called,
    );
  });

  it('add key POSTs to /keys and invalidates the list', async () => {
    let body: unknown;
    await expectCallAndInvalidate(
      http.post('/api/integrations/int-1/keys', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ apiKey: {}, token: 'bliss_x' }, { status: 201 });
      }),
      async (wrapper) => {
        const { result } = renderHook(() => useAddApiKey(), { wrapper });
        await act(async () => { await result.current.mutateAsync({ integrationId: 'int-1', expiresInDays: 30 }); });
      },
      () => body !== undefined,
    );
    expect(body).toEqual({ expiresInDays: 30 });
  });

  it('revoke key DELETEs the key and invalidates the list', async () => {
    let called = false;
    await expectCallAndInvalidate(
      http.delete('/api/integrations/int-1/keys/k1', () => { called = true; return HttpResponse.json({}); }),
      async (wrapper) => {
        const { result } = renderHook(() => useRevokeApiKey(), { wrapper });
        await act(async () => { await result.current.mutateAsync({ integrationId: 'int-1', keyId: 'k1' }); });
      },
      () => called,
    );
  });
});
