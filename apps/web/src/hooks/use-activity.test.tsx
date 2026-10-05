import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, MutationCache, useMutation } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import api from '@/lib/api';
import {
  activityPollInterval,
  buildActivityStatus,
  useActivity,
  useActivityStatus,
  useActivityWatcher,
  BUSY_POLL_MS,
  IDLE_POLL_MS,
} from './use-activity';
import {
  markActivityPending,
  setActivityQueryClient,
  settlePendingActivity,
  getPendingActivity,
  __resetPendingActivity,
  PENDING_GRACE_MS,
} from '@/lib/activity-pending';
import type { ActivityInFlightEntry, ActivityResponse } from '@/types/activity';

/**
 * Processing status hooks (#100): polling rules (R4.4), optimistic Queued
 * (R4.3 / AC1), one row per type (AC2) and page refresh on settle (AC3).
 */

vi.mock('@/lib/api', () => ({ default: { getActivity: vi.fn() } }));

let visible = true;
vi.mock('@/hooks/use-page-visible', () => ({ usePageVisible: () => visible }));

const idle: ActivityResponse = {
  available: true,
  workerOnline: true,
  serverTime: '2026-10-04T12:00:00.000Z',
  summary: {},
  inFlight: [],
  recent: [],
  lastCompletedAt: {},
};

const entry = (over: Partial<ActivityInFlightEntry> = {}): ActivityInFlightEntry => ({
  id: 'portfolio:1',
  type: 'PORTFOLIO_UPDATE',
  stage: 'updating_cash',
  state: 'running',
  progress: null,
  trigger: 'user_change',
  affects: ['PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE'],
  enqueuedAt: '2026-10-04T11:59:00.000Z',
  startedAt: '2026-10-04T11:59:10.000Z',
  updatedAt: '2026-10-04T11:59:50.000Z',
  ...over,
});

const busy: ActivityResponse = {
  ...idle,
  summary: {
    PORTFOLIO_UPDATE: { state: 'running', stage: 'updating_cash', progress: 40, count: 3, trigger: 'user_change', startedAt: null, affects: ['PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE'] },
  },
  inFlight: [entry(), entry({ id: 'portfolio:2' }), entry({ id: 'portfolio:3', state: 'queued' })],
};

function createWrapper(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    queryClient,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  visible = true;
  __resetPendingActivity();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('activityPollInterval (PRD R4.4)', () => {
  it('polls every ~5 s while anything is in flight or optimistically queued', () => {
    expect(activityPollInterval(busy, false, true)).toBe(BUSY_POLL_MS);
    expect(activityPollInterval(idle, true, true)).toBe(BUSY_POLL_MS);
  });

  it('polls every ~60 s when idle or before the first answer', () => {
    expect(activityPollInterval(idle, false, true)).toBe(IDLE_POLL_MS);
    expect(activityPollInterval(undefined, false, true)).toBe(IDLE_POLL_MS);
  });

  it('never polls while the tab is hidden', () => {
    expect(activityPollInterval(busy, true, false)).toBe(false);
  });

  it('does not treat an unavailable status as busy', () => {
    expect(activityPollInterval({ ...busy, available: false }, false, true)).toBe(IDLE_POLL_MS);
  });
});

describe('buildActivityStatus', () => {
  it('is hidden when everything is up to date (PRD OQ1)', () => {
    expect(buildActivityStatus(idle, []).chipState).toBe('hidden');
  });

  it('shows one row per type however many jobs are in flight (AC2)', () => {
    const status = buildActivityStatus(busy, []);
    expect(status.rows).toHaveLength(1);
    expect(status.rows[0]).toMatchObject({ type: 'PORTFOLIO_UPDATE', state: 'running', count: 3, progress: 40 });
    expect(status.chipState).toBe('running');
  });

  it('shows optimistic types as queued before the server confirms them (AC1)', () => {
    const status = buildActivityStatus(idle, [{ types: ['PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE'], at: Date.now() }]);
    expect(status.chipState).toBe('queued');
    expect(status.rows.map((r) => [r.type, r.state, r.optimistic])).toEqual([
      ['PORTFOLIO_UPDATE', 'queued', true],
      ['ANALYTICS_UPDATE', 'queued', true],
    ]);
  });

  it('a server row wins over an optimistic one of the same type', () => {
    const status = buildActivityStatus(busy, [{ types: ['PORTFOLIO_UPDATE'], at: Date.now() }]);
    expect(status.rows).toHaveLength(1);
    expect(status.rows[0].optimistic).toBeUndefined();
  });

  it('takes the most severe state: failed > stalled > running > queued', () => {
    const status = buildActivityStatus({
      ...idle,
      summary: {
        PORTFOLIO_UPDATE: { ...busy.summary.PORTFOLIO_UPDATE!, state: 'stalled' },
        ANALYTICS_UPDATE: { ...busy.summary.PORTFOLIO_UPDATE!, state: 'queued' },
      },
    }, []);
    expect(status.chipState).toBe('stalled');
    const failed = buildActivityStatus({
      ...idle,
      summary: { BANK_SYNC: { ...busy.summary.PORTFOLIO_UPDATE!, state: 'failed', errorCode: 'P2034' } },
    }, []);
    expect(failed.chipState).toBe('failed');
  });

  it('keeps insights off the chip (PRD OQ2)', () => {
    const status = buildActivityStatus({
      ...idle,
      summary: { INSIGHTS: { ...busy.summary.PORTFOLIO_UPDATE!, affects: ['INSIGHTS'] } },
      lastCompletedAt: { INSIGHTS: '2026-10-04T11:00:00.000Z', PORTFOLIO_UPDATE: '2026-10-04T10:00:00.000Z' },
    }, [{ types: ['INSIGHTS'], at: Date.now() }]);
    expect(status.chipState).toBe('hidden');
    expect(status.lastUpdatedAt).toBe('2026-10-04T10:00:00.000Z');
  });

  it('hides everything when status is unavailable, even an optimistic write', () => {
    const pending = [{ types: ['PORTFOLIO_UPDATE' as const], at: Date.now() }];
    expect(buildActivityStatus({ ...busy, available: false }, pending).chipState).toBe('hidden');
    expect(buildActivityStatus(undefined, pending, true).chipState).toBe('hidden');
  });

  it('flags an offline worker only when something is waiting', () => {
    expect(buildActivityStatus({ ...busy, workerOnline: false }, []).workerOffline).toBe(true);
    expect(buildActivityStatus({ ...idle, workerOnline: false }, []).workerOffline).toBe(false);
  });
});

describe('optimistic pending store', () => {
  it('a mutation with meta.activity marks its types pending and triggers a poll', async () => {
    vi.mocked(api.getActivity).mockResolvedValue(idle);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      mutationCache: new MutationCache({
        onSuccess: (_d, _v, _c, mutation) => {
          const types = mutation.options.meta?.activity;
          if (types?.length) markActivityPending(types);
        },
      }),
    });
    setActivityQueryClient(queryClient);
    const { wrapper } = createWrapper(queryClient);
    const { result } = renderHook(() => ({
      status: useActivityStatus(),
      mutation: useMutation({ mutationFn: async () => 'ok', meta: { activity: ['ANALYTICS_UPDATE'] } }),
    }), { wrapper });

    await waitFor(() => expect(api.getActivity).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.mutation.mutateAsync(); });

    expect(result.current.status.chipState).toBe('queued');
    await waitFor(() => expect(api.getActivity).toHaveBeenCalledTimes(2));
  });

  it('a poll that completed well after the write clears it; an early one does not', () => {
    markActivityPending(['PORTFOLIO_UPDATE']);
    const at = getPendingActivity()[0].at;
    settlePendingActivity(at + 100);
    expect(getPendingActivity()).toHaveLength(1);
    settlePendingActivity(at + 5_000);
    expect(getPendingActivity()).toHaveLength(0);
  });

  it('expires after the grace period even if no poll answers', () => {
    vi.useFakeTimers();
    markActivityPending(['PORTFOLIO_UPDATE']);
    expect(getPendingActivity()).toHaveLength(1);
    vi.advanceTimersByTime(PENDING_GRACE_MS + 1);
    expect(getPendingActivity()).toHaveLength(0);
  });

  it('ignores an empty type list', () => {
    markActivityPending([]);
    expect(getPendingActivity()).toHaveLength(0);
  });
});

describe('useActivity', () => {
  it('fetches the status', async () => {
    vi.mocked(api.getActivity).mockResolvedValue(busy);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useActivity(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(busy));
  });

  it('polls again after ~5 s while busy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getActivity).mockResolvedValue(busy);
    const { wrapper } = createWrapper();
    renderHook(() => useActivity(), { wrapper });
    await waitFor(() => expect(api.getActivity).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_POLL_MS + 100); });
    expect(api.getActivity).toHaveBeenCalledTimes(2);
  });
});

describe('useActivityWatcher (page banners, AC3)', () => {
  it('matches on affects: an edit\'s cash stage lights up the analytics pages (D3)', async () => {
    vi.mocked(api.getActivity).mockResolvedValue(busy);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useActivityWatcher(['ANALYTICS_UPDATE'], [['analytics']]), { wrapper });
    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(result.current.state).toBe('running');
    expect(result.current.primaryEntry?.stage).toBe('updating_cash');
  });

  it('ignores work that does not affect the page', async () => {
    vi.mocked(api.getActivity).mockResolvedValue(busy);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useActivityWatcher(['SUBSCRIPTION_SCAN'], [['subscriptions']]), { wrapper });
    await waitFor(() => expect(result.current.available).toBe(true));
    await waitFor(() => expect(api.getActivity).toHaveBeenCalled());
    expect(result.current.busy).toBe(false);
    expect(result.current.state).toBeNull();
  });

  it('invalidates the page queries when the work settles, not before', async () => {
    vi.mocked(api.getActivity).mockResolvedValueOnce(busy).mockResolvedValue({
      ...idle,
      lastCompletedAt: { ANALYTICS_UPDATE: '2026-10-04T12:01:00.000Z' },
    });
    const { wrapper, queryClient } = createWrapper();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => ({
      watch: useActivityWatcher(['ANALYTICS_UPDATE'], [['analytics'], ['dashboard-metrics']]),
      query: useActivity(),
    }), { wrapper });

    await waitFor(() => expect(result.current.watch.busy).toBe(true));
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['analytics'] });

    await act(async () => { await result.current.query.refetch(); });

    await waitFor(() => expect(result.current.watch.busy).toBe(false));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['analytics'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['dashboard-metrics'] });
    expect(result.current.watch.lastUpdatedAt).toBe('2026-10-04T12:01:00.000Z');
  });

  it('refreshes when a watched type completed between two polls (e.g. a nightly run, AC4)', async () => {
    vi.mocked(api.getActivity)
      .mockResolvedValueOnce({ ...idle, lastCompletedAt: { PORTFOLIO_UPDATE: '2026-10-04T04:00:00.000Z' } })
      .mockResolvedValue({ ...idle, lastCompletedAt: { PORTFOLIO_UPDATE: '2026-10-05T04:00:00.000Z' } });
    const { wrapper, queryClient } = createWrapper();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => ({
      watch: useActivityWatcher(['PORTFOLIO_UPDATE'], [['portfolio-holdings']]),
      query: useActivity(),
    }), { wrapper });

    await waitFor(() => expect(result.current.watch.lastUpdatedAt).toBe('2026-10-04T04:00:00.000Z'));
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['portfolio-holdings'] });
    await act(async () => { await result.current.query.refetch(); });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['portfolio-holdings'] }));
  });

  it('reports a recent failure of a watched type (AC8)', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({
      ...idle,
      summary: { ANALYTICS_UPDATE: { state: 'failed', stage: null, progress: null, count: 0, trigger: 'user_change', startedAt: null, affects: ['ANALYTICS_UPDATE'], errorCode: 'P2034' } },
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useActivityWatcher(['ANALYTICS_UPDATE'], []), { wrapper });
    await waitFor(() => expect(result.current.state).toBe('failed'));
    expect(result.current.failed).toEqual({ type: 'ANALYTICS_UPDATE', errorCode: 'P2034' });
  });
});
