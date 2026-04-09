import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { useTagAnalytics } from './use-tag-analytics';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
};

describe('useTagAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches tag analytics with valid filters', async () => {
    const mockAnalytics = {
      tags: [{ tagId: 1, name: 'Food', total: 500, breakdown: [] }],
    };
    vi.mocked(api.getTagAnalytics).mockResolvedValueOnce(
      mockAnalytics as unknown as Awaited<ReturnType<typeof api.getTagAnalytics>>,
    );

    const filters = { tagIds: [1, 2], view: 'year' as const, years: [2024] };
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useTagAnalytics(filters), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getTagAnalytics).toHaveBeenCalledWith(filters);
    expect(result.current.data).toEqual(mockAnalytics);
  });

  it('does not fetch when tagIds is empty', () => {
    const filters = { tagIds: [] as number[], view: 'year' as const, years: [2024] };
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useTagAnalytics(filters), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(api.getTagAnalytics).not.toHaveBeenCalled();
  });
});
