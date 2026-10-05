/**
 * Settings → Administration → Processing (#100, PRD R6 / AC12).
 * Live + last 24 h come from GET /api/activity; "Recent rebuilds" is the
 * history moved out of Maintenance (GET /api/admin/rebuild, unchanged).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

import { ProcessingTab } from './processing-tab';
import { api } from '@/lib/api';
import type { RebuildStatusResponse } from '@/types/api';
import type { ActivityResponse } from '@/types/activity';

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
          trigger: 'nightly', affects: ['PORTFOLIO_UPDATE'], enqueuedAt: ago(120_000), startedAt: ago(90_000), updatedAt: ago(1_000),
        },
        {
          id: 'analytics:2', type: 'ANALYTICS_UPDATE', stage: 'updating_analytics', state: 'queued', progress: null,
          trigger: 'agent', affects: ['ANALYTICS_UPDATE'], enqueuedAt: ago(5_000), startedAt: ago(5_000), updatedAt: ago(5_000),
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

  it('lists the last 24 hours with outcome, duration and error code (AC8)', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({
      ...idle,
      recent: [
        {
          id: 'analytics:9', type: 'ANALYTICS_UPDATE', stage: 'updating_analytics', state: 'failed', errorCode: 'P2034',
          trigger: 'user_change', enqueuedAt: ago(70_000), startedAt: ago(65_000), finishedAt: ago(60_000), durationMs: 5_000,
        },
        {
          id: 'portfolio:8', type: 'PORTFOLIO_UPDATE', stage: 'updating_cash', state: 'completed',
          trigger: 'bank_sync', enqueuedAt: ago(80_000), startedAt: ago(79_000), finishedAt: ago(75_000), durationMs: 4_000,
        },
      ],
    });
    renderTab();
    const rows = await screen.findAllByTestId('processing-recent-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('activity.states.failed');
    expect(rows[0]).toHaveTextContent('activity.processing.errorCode');
    expect(rows[1]).toHaveTextContent('activity.states.completed');
    expect(rows[1]).toHaveTextContent('activity.processing.took');
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
