/**
 * Settings → Administration → Processing (#100, PRD R6 / AC12).
 * Live + last 24 h come from GET /api/activity; "Recent rebuilds" is the
 * history moved out of Maintenance (GET /api/admin/rebuild, unchanged).
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

import { ProcessingTab } from './processing-tab';
import { api } from '@/lib/api';
import type { RebuildStatusResponse } from '@/types/api';
import type { ActivityRecentEntry, ActivityResponse } from '@/types/activity';

vi.mock('@/lib/api');

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProcessingTab />
    </QueryClientProvider>,
  );
}

const emptyStatus: RebuildStatusResponse = {
  locks: [],
  current: [],
  recent: [],
  assets: [],
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const idle: ActivityResponse = {
  available: true,
  workerOnline: true,
  serverTime: new Date().toISOString(),
  summary: {},
  inFlight: [],
  recent: [],
  lastCompletedAt: {},
};

describe('ProcessingTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getRebuildStatus).mockResolvedValue(emptyStatus);
    vi.mocked(api.getActivity).mockResolvedValue(idle);
  });

  it('shows the three sections and their empty states', async () => {
    renderTab();
    expect(await screen.findByText('activity.processing.liveEmpty')).toBeInTheDocument();
    expect(screen.getByText('activity.processing.recentEmpty')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'activity.processing.liveTitle' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'activity.processing.recentTitle' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'activity.processing.rebuildsTitle' })).toBeInTheDocument();
  });

  it('lists live work with stage, progress, trigger and elapsed time (AC4, AC5)', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({
      ...idle,
      inFlight: [
        {
          id: 'portfolio:1', type: 'PORTFOLIO_UPDATE', stage: 'valuing_assets', state: 'running', progress: 40,
          trigger: 'nightly', affects: ['PORTFOLIO_UPDATE'], runId: 'nightly-1', enqueuedAt: ago(120_000), startedAt: ago(90_000), updatedAt: ago(1_000),
        },
        {
          id: 'analytics:2', type: 'ANALYTICS_UPDATE', stage: 'updating_analytics', state: 'queued', progress: null,
          trigger: 'agent', affects: ['ANALYTICS_UPDATE'], runId: 'events:2', enqueuedAt: ago(5_000), startedAt: ago(5_000), updatedAt: ago(5_000),
        },
      ],
    });
    renderTab();
    const rows = await screen.findAllByTestId('processing-live-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('PORTFOLIO_UPDATE'); // defaultValue: no i18n instance in tests
    expect(rows[0]).toHaveTextContent('valuing_assets');
    expect(rows[0]).toHaveTextContent('40%');
    expect(rows[0]).toHaveTextContent('activity.triggers.nightly');
    expect(rows[0]).toHaveTextContent('activity.processing.elapsed');
    expect(rows[0].querySelector('[data-slot="progress"]')).not.toBeNull();
    expect(rows[1]).toHaveTextContent('activity.triggers.agent');
    expect(rows[1]).toHaveTextContent('activity.processing.queuedFor');
  });

  const step = (o: Partial<ActivityRecentEntry>): ActivityRecentEntry => ({
    id: 'portfolio:1', type: 'PORTFOLIO_UPDATE', stage: 'updating_cash', state: 'completed', trigger: 'user_change',
    runId: 'events:1', enqueuedAt: ago(80_000), startedAt: ago(79_000), finishedAt: ago(75_000), durationMs: 300, ...o,
  });

  it('shows one row per run (an edit is one row), with its jobs as expandable steps', async () => {
    const steps = [
      step({ id: 'portfolio:1', stage: 'recalculating_lots' }),
      step({ id: 'portfolio:2', stage: 'updating_cash' }),
      step({ id: 'analytics:3', type: 'ANALYTICS_UPDATE', stage: 'updating_analytics', durationMs: 4_000 }),
      step({ id: 'portfolio:4', stage: 'valuing_assets' }),
    ];
    vi.mocked(api.getActivity).mockResolvedValue({
      ...idle,
      recent: steps,
      runs: [{
        id: 'events:1', trigger: 'user_change', types: ['PORTFOLIO_UPDATE', 'ANALYTICS_UPDATE'], state: 'completed',
        startedAt: ago(79_000), finishedAt: ago(75_000), durationMs: 600, steps,
      }],
    });
    renderTab();
    const rows = await screen.findAllByTestId('processing-run-row');
    expect(rows).toHaveLength(1);
    // Both types in the title; the trigger and a sub-second duration in the subline.
    expect(rows[0]).toHaveTextContent('PORTFOLIO_UPDATE · ANALYTICS_UPDATE');
    expect(rows[0]).toHaveTextContent('activity.triggers.user_change');
    expect(rows[0]).toHaveTextContent('activity.processing.took');
    expect(screen.queryByTestId('processing-run-steps')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /activity\.processing\.steps/ }));
    const list = screen.getByTestId('processing-run-steps');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(list).toHaveTextContent('recalculating_lots');
    expect(list).toHaveTextContent('valuing_assets');
  });

  it('shows a failed run with its error code (AC8)', async () => {
    const failed = step({ id: 'analytics:9', type: 'ANALYTICS_UPDATE', state: 'failed', errorCode: 'P2034', runId: 'events:9' });
    vi.mocked(api.getActivity).mockResolvedValue({
      ...idle,
      recent: [failed],
      runs: [{
        id: 'events:9', trigger: 'bank_sync', types: ['ANALYTICS_UPDATE'], state: 'failed', errorCode: 'P2034',
        startedAt: failed.startedAt, finishedAt: failed.finishedAt, durationMs: 5_000, steps: [failed],
      }],
    });
    renderTab();
    const [row] = await screen.findAllByTestId('processing-run-row');
    expect(row).toHaveTextContent('activity.states.failed');
    expect(row).toHaveTextContent('activity.processing.errorCode');
    expect(row).toHaveTextContent('activity.triggers.bank_sync');
    // A single-step run has nothing to expand.
    expect(screen.queryByRole('button', { name: /activity\.processing\.steps/ })).not.toBeInTheDocument();
  });

  it('falls back to one row per job against an older API without runs', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ ...idle, recent: [step({ id: 'a' }), step({ id: 'b', runId: 'b' })] });
    renderTab();
    expect(await screen.findAllByTestId('processing-run-row')).toHaveLength(2);
  });

  it('says when status is unavailable or the worker is offline', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ ...idle, available: false, workerOnline: null });
    renderTab();
    expect(await screen.findByText('activity.processing.unavailable')).toBeInTheDocument();
  });

  it('flags an offline worker', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ ...idle, workerOnline: false });
    renderTab();
    expect(await screen.findByText('activity.processing.workerOffline')).toBeInTheDocument();
  });

  // ── Recent rebuilds (moved from the Maintenance tab, AC12) ──────────────

  it('shows the empty-state message when there are no recent rebuilds', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue(emptyStatus);

    renderTab();

    await waitFor(() => {
      expect(
        screen.getByText(/No recent rebuilds\./),
      ).toBeInTheDocument();
    });
  });

  it('renders a history entry for a completed rebuild', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue({
      ...emptyStatus,
      recent: [
        {
          id: 42,
          name: 'full-rebuild-analytics',
          state: 'completed',
          progress: 100,
          rebuildType: 'full-analytics',
          requestedBy: 'alice@example.com',
          requestedAt: '2026-04-23T10:00:00.000Z',
          startedAt: '2026-04-23T10:00:02.000Z',
          finishedAt: new Date(Date.now() - 60_000).toISOString(),
          failedReason: null,
          attemptsMade: 1,
        },
      ],
    });

    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Full analytics')).toBeInTheDocument();
    });
    expect(screen.getByText(/alice@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/Completed/)).toBeInTheDocument();
  });

  it('renders distinct step labels for each subjob of a full-portfolio chain', async () => {
    // A full-portfolio rebuild produces 4 BullMQ subjobs, each with the
    // same `rebuildType: 'full-portfolio'` but different `name`. The UI
    // must show all 4 as separate history rows so mid-chain failures
    // are precisely located and so the admin can see the chain
    // progressing. Scope label ("Full rebuild") stays constant; the
    // step label differentiates the rows.
    const requestedAt = '2026-04-23T10:00:00.000Z';
    const baseJob = {
      rebuildType: 'full-portfolio' as const,
      requestedBy: 'admin@example.com',
      requestedAt,
      startedAt: requestedAt,
      state: 'completed' as const,
      progress: 100,
      failedReason: null,
      attemptsMade: 1,
    };
    vi.mocked(api.getRebuildStatus).mockResolvedValue({
      ...emptyStatus,
      recent: [
        { ...baseJob, id: 1, name: 'process-portfolio-changes', finishedAt: '2026-04-23T10:00:30.000Z' },
        { ...baseJob, id: 2, name: 'process-cash-holdings',     finishedAt: '2026-04-23T10:01:00.000Z' },
        { ...baseJob, id: 3, name: 'full-rebuild-analytics',    finishedAt: '2026-04-23T10:02:00.000Z' },
        { ...baseJob, id: 4, name: 'value-all-assets',          finishedAt: '2026-04-23T10:05:00.000Z' },
      ],
    });

    renderTab();

    // Step labels render with a "·" separator prefix to distinguish them
    // from button labels that happen to share the same words (e.g. the
    // full-analytics button literally says "Rebuild analytics"). Use the
    // prefix to anchor the selector to the history row rather than the
    // button. Four distinct step labels prove four distinct rows.
    await waitFor(() => {
      expect(screen.getByText(/· Sync transactions.*portfolio items/)).toBeInTheDocument();
    });
    expect(screen.getByText(/· Rebuild cash holdings/)).toBeInTheDocument();
    expect(screen.getByText(/· Rebuild analytics/)).toBeInTheDocument();
    expect(screen.getByText(/· Revalue all assets/)).toBeInTheDocument();
    // ("Full rebuild" scope label appears on every row too, but it also
    // shows up as the card heading, so we can't cleanly assert on its
    // count here — the 4 unique step labels above are the rigorous
    // signal that each row rendered distinctly.)
  });
});
