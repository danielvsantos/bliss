import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { api } from '@/lib/api';
import { useRebuildStatus, useTriggerRebuild, REBUILD_STATUS_QUERY_KEY } from './use-rebuild';
import type { RebuildStatusResponse, RebuildTriggerResponse } from '@/types/api';

vi.mock('@/lib/api');

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

const emptyStatus: RebuildStatusResponse = {
  locks: [
    { scope: 'full-portfolio', held: false, ttlSeconds: null },
    { scope: 'full-analytics', held: false, ttlSeconds: null },
    { scope: 'scoped-analytics', held: false, ttlSeconds: null },
    { scope: 'single-asset', held: false, ttlSeconds: null },
  ],
  current: [],
  recent: [],
};

describe('useRebuildStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches rebuild status from the API', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValueOnce(emptyStatus);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useRebuildStatus({ pollMs: 60_000 }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getRebuildStatus).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(emptyStatus);
  });

  it('can be disabled to skip the fetch', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValueOnce(emptyStatus);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useRebuildStatus({ enabled: false }), { wrapper });

    // No fetch should fire when disabled.
    await new Promise((r) => setTimeout(r, 30));
    expect(api.getRebuildStatus).not.toHaveBeenCalled();
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useTriggerRebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts the scope + payload and returns the trigger response', async () => {
    const response: RebuildTriggerResponse = {
      status: 'accepted',
      scope: 'full-analytics',
      requestedAt: '2026-04-23T10:00:00.000Z',
      lockTtlSeconds: 3600,
    };
    vi.mocked(api.triggerRebuild).mockResolvedValueOnce(response);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTriggerRebuild(), { wrapper });

    let returned: RebuildTriggerResponse | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync({ scope: 'full-analytics' });
    });

    expect(api.triggerRebuild).toHaveBeenCalledWith({ scope: 'full-analytics' });
    expect(returned).toEqual(response);
  });

  it('invalidates the rebuild status query on success so the UI refetches immediately', async () => {
    vi.mocked(api.triggerRebuild).mockResolvedValueOnce({
      status: 'accepted',
      scope: 'single-asset',
      requestedAt: '2026-04-23T10:00:00.000Z',
      lockTtlSeconds: 3600,
    });

    const { wrapper, queryClient } = makeWrapper();
    // Seed the cache with stale status so we can assert the invalidation.
    queryClient.setQueryData(REBUILD_STATUS_QUERY_KEY, emptyStatus);

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useTriggerRebuild(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        scope: 'single-asset',
        payload: { portfolioItemId: 42 },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: REBUILD_STATUS_QUERY_KEY });
  });

  it('surfaces errors from the API (e.g. 409 already running)', async () => {
    const err = Object.assign(new Error('Request failed with status code 409'), {
      response: { status: 409, data: { error: 'Rebuild already in progress', ttlSeconds: 1200 } },
    });
    vi.mocked(api.triggerRebuild).mockRejectedValueOnce(err);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useTriggerRebuild(), { wrapper });

    await expect(
      result.current.mutateAsync({ scope: 'full-portfolio' }),
    ).rejects.toBe(err);
  });
});
