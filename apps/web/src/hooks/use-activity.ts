import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import api from '@/lib/api';
import { usePageVisible } from '@/hooks/use-page-visible';
import {
  ACTIVITY_QUERY_KEY,
  getPendingActivity,
  settlePendingActivity,
  subscribePendingActivity,
  type PendingActivity,
} from '@/lib/activity-pending';
import type {
  ActivityInFlightEntry,
  ActivityResponse,
  ActivitySummaryRow,
  ActivityTrigger,
  ActivityType,
} from '@/types/activity';

/**
 * Processing status (#100): what background work is in flight for the tenant.
 *
 * Polling (PRD R4.4): ~5 s while anything is in flight (or optimistically
 * queued), ~60 s when idle, on window focus, and never while the tab is
 * hidden. Each poll is one Redis pipeline on the API side.
 */

export const BUSY_POLL_MS = 5_000;
export const IDLE_POLL_MS = 60_000;

/** Insights generation changes no numbers: it stays off the header chip (PRD OQ2). */
export const CHIP_EXCLUDED_TYPES: ActivityType[] = ['INSIGHTS'];

export type ChipState = 'hidden' | 'queued' | 'running' | 'stalled' | 'failed';

const SEVERITY: Record<Exclude<ChipState, 'hidden'>, number> = { queued: 1, running: 2, stalled: 3, failed: 4 };

export function usePendingActivity(): PendingActivity[] {
  return useSyncExternalStore(subscribePendingActivity, getPendingActivity, getPendingActivity);
}

const isBusy = (data: ActivityResponse | undefined) => Boolean(data?.available && data.inFlight.length > 0);

/** The polling rule (PRD R4.4), pure for tests: hidden → off, busy or pending → 5 s, idle → 60 s. */
export function activityPollInterval(data: ActivityResponse | undefined, hasPending: boolean, visible: boolean): number | false {
  if (!visible) return false;
  return isBusy(data) || hasPending ? BUSY_POLL_MS : IDLE_POLL_MS;
}

export function useActivity() {
  const visible = usePageVisible();
  const pending = usePendingActivity();
  const hasPending = pending.length > 0;

  const query = useQuery<ActivityResponse>({
    queryKey: ACTIVITY_QUERY_KEY,
    queryFn: () => api.getActivity(),
    refetchInterval: (q) => activityPollInterval(q.state.data, hasPending, visible),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 2_000,
    retry: false,
  });

  const { dataUpdatedAt } = query;
  useEffect(() => {
    if (dataUpdatedAt) settlePendingActivity(dataUpdatedAt);
  }, [dataUpdatedAt]);

  return query;
}

export interface ActivityRow {
  type: ActivityType;
  state: Exclude<ChipState, 'hidden'>;
  stage: string | null;
  progress: number | null;
  count: number;
  trigger: ActivityTrigger | null;
  errorCode?: string;
  /** Shown from an optimistic write, not yet confirmed by the server. */
  optimistic?: boolean;
}

export interface ActivityStatus {
  data: ActivityResponse | undefined;
  /** False when status cannot be read (no Redis, request failed): show nothing rather than "up to date". */
  available: boolean;
  /** One row per activity type (the chip and popover), optimistic types included. */
  rows: ActivityRow[];
  chipState: ChipState;
  /** Most recent completion across the types shown on the chip. */
  lastUpdatedAt: string | null;
  workerOffline: boolean;
}

function rowFromSummary(type: ActivityType, row: ActivitySummaryRow): ActivityRow {
  return {
    type,
    state: row.state,
    stage: row.stage,
    progress: row.progress,
    count: row.count,
    trigger: row.trigger,
    errorCode: row.errorCode,
  };
}

/** Pure: server summary + optimistic writes → the chip view. Exported for tests. */
export function buildActivityStatus(
  data: ActivityResponse | undefined,
  pending: PendingActivity[],
  isError = false,
): ActivityStatus {
  const loadedButUnavailable = isError || (data !== undefined && !data.available);
  const rows: ActivityRow[] = [];

  if (!loadedButUnavailable) {
    for (const [type, row] of Object.entries(data?.summary ?? {}) as Array<[ActivityType, ActivitySummaryRow]>) {
      if (!CHIP_EXCLUDED_TYPES.includes(type)) rows.push(rowFromSummary(type, row));
    }
    for (const p of pending) {
      for (const type of p.types) {
        if (CHIP_EXCLUDED_TYPES.includes(type) || rows.some((r) => r.type === type)) continue;
        rows.push({ type, state: 'queued', stage: null, progress: null, count: 1, trigger: null, optimistic: true });
      }
    }
  }

  const chipState = rows.reduce<ChipState>(
    (worst, r) => (worst === 'hidden' || SEVERITY[r.state] > SEVERITY[worst] ? r.state : worst),
    'hidden',
  );

  const lastUpdatedAt = Object.entries(data?.lastCompletedAt ?? {})
    .filter(([type]) => !CHIP_EXCLUDED_TYPES.includes(type as ActivityType))
    .map(([, at]) => at as string)
    .sort()
    .pop() ?? null;

  return {
    data,
    available: !loadedButUnavailable,
    rows,
    chipState,
    lastUpdatedAt,
    // A down worker means nothing in flight can progress.
    workerOffline: data?.workerOnline === false && ((data?.inFlight.length ?? 0) > 0 || rows.some((r) => r.optimistic)),
  };
}

export function useActivityStatus(): ActivityStatus {
  const { data, isError } = useActivity();
  const pending = usePendingActivity();
  return useMemo(() => buildActivityStatus(data, pending, isError), [data, pending, isError]);
}

export interface WatchedActivity {
  /** Something that will change this page's numbers is queued / running / stalled. */
  busy: boolean;
  state: Exclude<ChipState, 'hidden'> | null;
  /** The longest-running entry affecting the page (stage + progress for the banner). */
  primaryEntry: ActivityInFlightEntry | null;
  /** A recent final failure of a watched type (until that type completes again). */
  failed: { type: ActivityType; errorCode?: string } | null;
  /** `lastCompletedAt` of the page's primary type. */
  lastUpdatedAt: string | null;
  available: boolean;
}

/**
 * Page banners (PRD R5): is anything that affects `types` in flight? When it
 * settles — the last affecting entry finishes, or a watched type's
 * `lastCompletedAt` moves — the page's queries are invalidated so its numbers
 * refresh without a reload.
 */
export function useActivityWatcher(
  types: ActivityType[],
  invalidateKeys: QueryKey[],
  primary: ActivityType = types[0],
): WatchedActivity {
  const queryClient = useQueryClient();
  const { data, isError } = useActivity();
  const pending = usePendingActivity();
  const typesKey = types.join(',');

  const view = useMemo<WatchedActivity>(() => {
    const available = !isError && data?.available !== false;
    if (!available) {
      return { busy: false, state: null, primaryEntry: null, failed: null, lastUpdatedAt: null, available };
    }
    const watched = typesKey.split(',') as ActivityType[];
    const affecting = (data?.inFlight ?? []).filter((e) => e.affects.some((t) => watched.includes(t)));
    const optimistic = pending.some((p) => p.types.some((t) => watched.includes(t)));

    let failed: WatchedActivity['failed'] = null;
    for (const [type, row] of Object.entries(data?.summary ?? {}) as Array<[ActivityType, ActivitySummaryRow]>) {
      if (row.state === 'failed' && (watched.includes(type) || row.affects.some((t) => watched.includes(t)))) {
        failed = { type, errorCode: row.errorCode };
        break;
      }
    }

    let state: WatchedActivity['state'] = null;
    if (affecting.some((e) => e.state === 'stalled')) state = 'stalled';
    else if (affecting.some((e) => e.state === 'running')) state = 'running';
    else if (affecting.length > 0 || optimistic) state = 'queued';
    if (!state && failed) state = 'failed';

    return {
      busy: affecting.length > 0 || optimistic,
      state,
      primaryEntry: affecting.find((e) => e.state === 'running') ?? affecting[0] ?? null,
      failed,
      lastUpdatedAt: data?.lastCompletedAt?.[primary] ?? null,
      available,
    };
  }, [data, isError, pending, typesKey, primary]);

  const lastStamp = useMemo(
    () => typesKey.split(',').map((t) => data?.lastCompletedAt?.[t as ActivityType] ?? '').join('|'),
    [data, typesKey],
  );

  const prev = useRef<{ busy: boolean; stamp: string | null }>({ busy: view.busy, stamp: null });
  const keysRef = useRef(invalidateKeys);
  keysRef.current = invalidateKeys;

  useEffect(() => {
    const before = prev.current;
    const settled = before.busy && !view.busy;
    const completedSince = before.stamp !== null && data !== undefined && before.stamp !== lastStamp;
    if (settled || completedSince) {
      for (const queryKey of keysRef.current) queryClient.invalidateQueries({ queryKey });
    }
    prev.current = { busy: view.busy, stamp: data !== undefined ? lastStamp : before.stamp };
  }, [view.busy, lastStamp, data, queryClient]);

  return view;
}
