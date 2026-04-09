import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api from '@/lib/api';
import React from 'react';
import { useInsights, useDismissInsight, useGenerateInsights } from './use-insights';
import type { InsightTier, InsightCategory } from './use-insights';

vi.mock('@/lib/api', () => ({
  default: {
    getInsights: vi.fn(),
    dismissInsight: vi.fn(),
    generateInsights: vi.fn(),
  },
}));

const emptyListResponse = {
  insights: [],
  total: 0,
  tierSummary: {},
  categoryCounts: {},
};

const dismissOk = { id: 'ins-1', dismissed: true };
const generateOk = { message: 'Insight generation triggered', tier: 'DAILY' };

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

// ---------------------------------------------------------------------------
// useInsights — filter passthrough
// ---------------------------------------------------------------------------

describe('useInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches insights with the default (empty filter) payload', async () => {
    const mockResponse = {
      insights: [
        {
          id: 'ins-1',
          lens: 'SPENDING_VELOCITY',
          tier: 'DAILY',
          category: 'SPENDING',
          periodKey: '2026-04-09',
          severity: 'WARNING',
          title: 'Spending up',
        },
      ],
      total: 1,
      tierSummary: { DAILY: { latestDate: '2026-04-09', latestCreatedAt: '2026-04-09T06:00:00Z' } },
      categoryCounts: { SPENDING: 1 },
    };
    vi.mocked(api.getInsights).mockResolvedValueOnce(mockResponse);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useInsights(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getInsights).toHaveBeenCalledWith(undefined);
    expect(result.current.data).toEqual(mockResponse);
  });

  it('passes limit and offset through to the API client', async () => {
    vi.mocked(api.getInsights).mockResolvedValueOnce(emptyListResponse);

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useInsights({ limit: 50, offset: 100 }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getInsights).toHaveBeenCalledWith({ limit: 50, offset: 100 });
  });

  it('passes tier filter through to the API client', async () => {
    vi.mocked(api.getInsights).mockResolvedValueOnce(emptyListResponse);

    const { wrapper } = createWrapper();
    const tier: InsightTier = 'MONTHLY';
    const { result } = renderHook(() => useInsights({ tier }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getInsights).toHaveBeenCalledWith({ tier: 'MONTHLY' });
  });

  it('passes category filter through to the API client', async () => {
    vi.mocked(api.getInsights).mockResolvedValueOnce(emptyListResponse);

    const { wrapper } = createWrapper();
    const category: InsightCategory = 'SPENDING';
    const { result } = renderHook(() => useInsights({ category }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getInsights).toHaveBeenCalledWith({ category: 'SPENDING' });
  });

  it('passes periodKey filter through to the API client', async () => {
    vi.mocked(api.getInsights).mockResolvedValueOnce(emptyListResponse);

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useInsights({ periodKey: '2026-Q1' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getInsights).toHaveBeenCalledWith({ periodKey: '2026-Q1' });
  });

  it('passes includeDismissed=true through to the API client', async () => {
    vi.mocked(api.getInsights).mockResolvedValueOnce(emptyListResponse);

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useInsights({ includeDismissed: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getInsights).toHaveBeenCalledWith({ includeDismissed: true });
  });

  it('passes combined filters through in a single call', async () => {
    vi.mocked(api.getInsights).mockResolvedValueOnce(emptyListResponse);

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useInsights({
          tier: 'QUARTERLY',
          category: 'PORTFOLIO',
          periodKey: '2026-Q1',
          severity: 'WARNING',
          limit: 10,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getInsights).toHaveBeenCalledWith({
      tier: 'QUARTERLY',
      category: 'PORTFOLIO',
      periodKey: '2026-Q1',
      severity: 'WARNING',
      limit: 10,
    });
  });

  it('uses distinct query keys per filter combination for cache isolation', async () => {
    vi.mocked(api.getInsights).mockResolvedValue(emptyListResponse);

    const { wrapper } = createWrapper();
    const { rerender, result } = renderHook(
      ({ tier }: { tier: InsightTier }) => useInsights({ tier }),
      { wrapper, initialProps: { tier: 'DAILY' as InsightTier } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ tier: 'MONTHLY' });
    await waitFor(() => expect(api.getInsights).toHaveBeenCalledTimes(2));

    expect(api.getInsights).toHaveBeenNthCalledWith(1, { tier: 'DAILY' });
    expect(api.getInsights).toHaveBeenNthCalledWith(2, { tier: 'MONTHLY' });
  });
});

// ---------------------------------------------------------------------------
// useDismissInsight
// ---------------------------------------------------------------------------

describe('useDismissInsight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls dismiss and invalidates the insights cache', async () => {
    vi.mocked(api.dismissInsight).mockResolvedValueOnce(dismissOk);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDismissInsight(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ insightId: 'ins-1', dismissed: true });
    });

    expect(api.dismissInsight).toHaveBeenCalledWith('ins-1', true);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['insights'] });
  });

  it('supports restoring (dismissed=false) as well', async () => {
    vi.mocked(api.dismissInsight).mockResolvedValueOnce(dismissOk);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDismissInsight(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ insightId: 'ins-2', dismissed: false });
    });

    expect(api.dismissInsight).toHaveBeenCalledWith('ins-2', false);
  });
});

// ---------------------------------------------------------------------------
// useGenerateInsights
// ---------------------------------------------------------------------------

describe('useGenerateInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers generation without options and invalidates after 5s', async () => {
    vi.mocked(api.generateInsights).mockResolvedValueOnce(generateOk);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useGenerateInsights(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(undefined);
    });

    expect(api.generateInsights).toHaveBeenCalledOnce();
    expect(api.generateInsights).toHaveBeenCalledWith(undefined);

    // Invalidation happens after a 5-second setTimeout
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['insights'] });
  });

  it('forwards MONTHLY tier with year and month', async () => {
    vi.mocked(api.generateInsights).mockResolvedValueOnce(generateOk);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGenerateInsights(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ tier: 'MONTHLY', year: 2026, month: 3 });
    });

    expect(api.generateInsights).toHaveBeenCalledWith({
      tier: 'MONTHLY',
      year: 2026,
      month: 3,
    });
  });

  it('forwards QUARTERLY tier with year and quarter', async () => {
    vi.mocked(api.generateInsights).mockResolvedValueOnce(generateOk);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGenerateInsights(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ tier: 'QUARTERLY', year: 2026, quarter: 1 });
    });

    expect(api.generateInsights).toHaveBeenCalledWith({
      tier: 'QUARTERLY',
      year: 2026,
      quarter: 1,
    });
  });

  it('forwards ANNUAL tier with year and force flag', async () => {
    vi.mocked(api.generateInsights).mockResolvedValueOnce(generateOk);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGenerateInsights(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ tier: 'ANNUAL', year: 2025, force: true });
    });

    expect(api.generateInsights).toHaveBeenCalledWith({
      tier: 'ANNUAL',
      year: 2025,
      force: true,
    });
  });

  it('forwards PORTFOLIO tier without period params', async () => {
    vi.mocked(api.generateInsights).mockResolvedValueOnce(generateOk);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGenerateInsights(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ tier: 'PORTFOLIO' });
    });

    expect(api.generateInsights).toHaveBeenCalledWith({ tier: 'PORTFOLIO' });
  });

  it('forwards a specific periodKey with force=true (manual refresh flow)', async () => {
    vi.mocked(api.generateInsights).mockResolvedValueOnce(generateOk);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useGenerateInsights(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        tier: 'QUARTERLY',
        year: 2026,
        quarter: 1,
        periodKey: '2026-Q1',
        force: true,
      });
    });

    expect(api.generateInsights).toHaveBeenCalledWith({
      tier: 'QUARTERLY',
      year: 2026,
      quarter: 1,
      periodKey: '2026-Q1',
      force: true,
    });
  });
});
