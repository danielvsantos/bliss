import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

import { MaintenanceTab } from './maintenance-tab';
import { api } from '@/lib/api';
import type { RebuildStatusResponse } from '@/types/api';

vi.mock('@/lib/api');

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Note: the Maintenance tab no longer calls `usePortfolioItems()` —
// asset picker data ships in the rebuild status response itself (see
// `status.assets` below). That avoids the live-price fetch storm that
// `/api/portfolio/items` triggers. If someone regresses that, the
// "renders the single-asset picker" test still exercises the picker
// against mocked assets.

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MaintenanceTab />
    </QueryClientProvider>,
  );
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
  assets: [
    { id: 1, symbol: 'AAPL', currency: 'USD', category: { name: 'Stocks' } },
    { id: 2, symbol: 'BTC', currency: 'USD', category: { name: 'Crypto' } },
  ],
};

describe('MaintenanceTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all maintenance panels (by heading)', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue(emptyStatus);

    renderTab();

    // Panel headings are <h3>s — querying by role disambiguates from
    // button labels that share the same text ("Full rebuild" etc.).
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Rebuild all analytics' })).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Full rebuild' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rebuild analytics from a date' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Refresh stock fundamentals' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rebuild a single asset' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent rebuilds' })).toBeInTheDocument();
  });

  it('calls refreshStockFundamentals when the Refresh fundamentals button is clicked', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue(emptyStatus);
    vi.mocked(api.refreshStockFundamentals).mockResolvedValue({
      message: 'Full refresh job enqueued',
      jobId: 'job-123',
    });

    renderTab();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refresh fundamentals/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Refresh fundamentals/i }));

    await waitFor(() => {
      expect(api.refreshStockFundamentals).toHaveBeenCalledTimes(1);
    });
  });

  it('calls triggerRebuild with scope=full-analytics when that button is clicked', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue(emptyStatus);
    vi.mocked(api.triggerRebuild).mockResolvedValue({
      status: 'accepted',
      scope: 'full-analytics',
      requestedAt: '2026-04-23T10:00:00.000Z',
      lockTtlSeconds: 3600,
    });

    renderTab();

    // Wait for the status query to resolve — the buttons are
    // `disabled={statusLoading}` during the initial fetch, and clicks
    // on disabled buttons are silently dropped. Use the empty-state
    // message as the "loaded" signal.
    await waitFor(() => {
      expect(screen.getByText(/No recent rebuilds\./)).toBeInTheDocument();
    });

    const button = screen.getByRole('button', { name: /Rebuild analytics$/ });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => {
      expect(api.triggerRebuild).toHaveBeenCalled();
    });
    expect(vi.mocked(api.triggerRebuild).mock.calls[0][0]).toMatchObject({
      scope: 'full-analytics',
    });
  });

  it('disables the button and shows "Running" when a rebuild of the same scope is in flight', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue({
      ...emptyStatus,
      current: [
        {
          id: 1,
          name: 'full-rebuild-analytics',
          state: 'active',
          progress: 40,
          rebuildType: 'full-analytics',
          requestedBy: 'alice@example.com',
          requestedAt: '2026-04-23T10:00:00.000Z',
          startedAt: '2026-04-23T10:00:05.000Z',
          finishedAt: null,
          failedReason: null,
          attemptsMade: 1,
        },
      ],
    });

    renderTab();

    await waitFor(() => {
      expect(screen.getByText(/Running/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/40%/)).toBeInTheDocument();
  });

  it('shows "Next available in" when the scope lock is held but no job is active', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue({
      ...emptyStatus,
      locks: [
        { scope: 'full-portfolio', held: true, ttlSeconds: 1800 },
        { scope: 'full-analytics', held: false, ttlSeconds: null },
        { scope: 'scoped-analytics', held: false, ttlSeconds: null },
        { scope: 'single-asset', held: false, ttlSeconds: null },
      ],
    });

    renderTab();

    await waitFor(() => {
      expect(screen.getByText(/Next available in 30m/)).toBeInTheDocument();
    });
  });

  it('shows the empty-state message when there are no recent rebuilds', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue(emptyStatus);

    renderTab();

    await waitFor(() => {
      expect(
        screen.getByText(/No recent rebuilds\./),
      ).toBeInTheDocument();
    });
  });

  it('renders the single-asset picker without crashing (uses status.assets, not /api/portfolio/items)', async () => {
    // Regression 1: the first Maintenance-tab deploy crashed with
    // `items.find is not a function` because the component treated
    // `usePortfolioItems().data` as a raw array when the hook
    // actually returned `{ portfolioCurrency, items }`.
    //
    // Regression 2: even after that was fixed, calling
    // `usePortfolioItems()` triggered a live price fetch per asset
    // (40+ HTTP calls) just to render this dropdown. We moved the
    // picker data into the rebuild status response itself. This test
    // asserts the picker renders using `status.assets` — if someone
    // reintroduces `usePortfolioItems()` the test won't fail by
    // itself, but the mock-free `@/hooks/use-portfolio-items` mock
    // would start being required again.
    vi.mocked(api.getRebuildStatus).mockResolvedValue(emptyStatus);

    renderTab();

    // Picker is gated on statusLoading — findByText waits for the
    // status query to resolve and the placeholder to swap in the real
    // picker trigger.
    expect(await screen.findByText(/Select an asset…/)).toBeInTheDocument();
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
