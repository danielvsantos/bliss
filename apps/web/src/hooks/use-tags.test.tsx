import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { useTags, useCreateTag, useUpdateTag } from './use-tags';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
    queryClient,
  };
};

describe('useTags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches tags list', async () => {
    const mockTags = [
      { id: 1, name: 'Food', color: '#ff0000' },
      { id: 2, name: 'Travel', color: '#00ff00' },
    ];
    vi.mocked(api.getTags).mockResolvedValueOnce(mockTags as any);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useTags(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getTags).toHaveBeenCalledOnce();
    expect(result.current.data).toEqual(mockTags);
  });

  it('does not refetch within staleTime', async () => {
    const mockTags = [{ id: 1, name: 'Food', color: '#ff0000' }];
    vi.mocked(api.getTags).mockResolvedValue(mockTags as any);

    const { wrapper, queryClient } = createWrapper();
    const { result } = renderHook(() => useTags(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getTags).toHaveBeenCalledTimes(1);

    // Manually trigger a refetch attempt via invalidation — but the data is still fresh
    // Since staleTime is 5 minutes, a re-render should not trigger another fetch
    const { result: result2 } = renderHook(() => useTags(), { wrapper });
    await waitFor(() => expect(result2.current.isSuccess).toBe(true));

    // Still only one call because data is within staleTime
    expect(api.getTags).toHaveBeenCalledTimes(1);
  });
});

describe('useCreateTag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.createTag and invalidates cache', async () => {
    const newTag = { id: 3, name: 'Gym', color: '#0000ff' };
    vi.mocked(api.createTag).mockResolvedValueOnce(newTag as any);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateTag(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ name: 'Gym', color: '#0000ff' } as any);
    });

    expect(api.createTag).toHaveBeenCalledWith({ name: 'Gym', color: '#0000ff' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tags'] });
  });
});

describe('useUpdateTag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.updateTag and invalidates cache', async () => {
    const updatedTag = { id: 1, name: 'Groceries', color: '#ff0000' };
    vi.mocked(api.updateTag).mockResolvedValueOnce(updatedTag as any);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateTag(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 1, data: { name: 'Groceries' } } as any);
    });

    expect(api.updateTag).toHaveBeenCalledWith(1, { name: 'Groceries' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tags'] });
  });
});
