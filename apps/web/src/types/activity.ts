/**
 * Processing status (#100) — mirrors `GET /api/activity`
 * (`summarize()` in @bliss/shared/activity). Types, stages and triggers are
 * keys; the UI translates them under `activity.*`.
 */

export type ActivityType =
  | 'PORTFOLIO_UPDATE'
  | 'ANALYTICS_UPDATE'
  | 'BANK_SYNC'
  | 'IMPORT'
  | 'SECURITY_DATA'
  | 'SUBSCRIPTION_SCAN'
  | 'INSIGHTS';

export type ActivityInFlightState = 'queued' | 'running' | 'stalled';
export type ActivityFinishedState = 'completed' | 'failed';
export type ActivityTrigger = 'user_change' | 'bank_sync' | 'import' | 'nightly' | 'manual_rebuild' | 'agent' | 'auto_refresh';

export interface ActivitySummaryRow {
  state: ActivityInFlightState | 'failed';
  stage: string | null;
  progress: number | null;
  count: number;
  trigger: ActivityTrigger;
  startedAt: string | null;
  affects: ActivityType[];
  errorCode?: string;
}

export interface ActivityInFlightEntry {
  id: string;
  type: ActivityType;
  stage: string | null;
  state: ActivityInFlightState;
  progress: number | null;
  trigger: ActivityTrigger;
  affects: ActivityType[];
  /** The chain (edit / sync / import / rebuild / nightly run) this job belongs to. */
  runId: string;
  enqueuedAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface ActivityRecentEntry {
  id: string;
  type: ActivityType;
  stage: string | null;
  state: ActivityFinishedState;
  trigger: ActivityTrigger;
  errorCode?: string;
  runId: string;
  enqueuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

/** One finished run: every job of one edit / sync / import / rebuild / nightly run. */
export interface ActivityRun {
  id: string;
  trigger: ActivityTrigger;
  /** Activity types the run touched, in order. */
  types: ActivityType[];
  state: ActivityFinishedState;
  errorCode?: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  steps: ActivityRecentEntry[];
}

export interface ActivityResponse {
  available: boolean;
  workerOnline: boolean | null;
  serverTime: string;
  summary: Partial<Record<ActivityType, ActivitySummaryRow>>;
  inFlight: ActivityInFlightEntry[];
  recent: ActivityRecentEntry[];
  /** `recent` grouped by run, newest first (older API: absent). */
  runs?: ActivityRun[];
  lastCompletedAt: Partial<Record<ActivityType, string>>;
}
