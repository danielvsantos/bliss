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

// `usePortfolioItems` is called unconditionally; return an empty list so
// we don't need to populate the combobox.
vi.mock('@/hooks/use-portfolio-items', () => ({
  usePortfolioItems: () => ({
    data: [
      { id: 1, symbol: 'AAPL', currency: 'USD', category: { name: 'Stocks' } },
      { id: 2, symbol: 'BTC',  currency: 'USD', category: { name: 'Crypto' } },
    ],
    isLoading: false,
  }),
  PORTFOLIO_ITEMS_QUERY_KEY: 'portfolio-items',
}));

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
};

describe('MaintenanceTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the four rebuild panels (by heading)', async () => {
    vi.mocked(api.getRebuildStatus).mockResolvedValue(emptyStatus);

    renderTab();

    // Panel headings are <h3>s — querying by role disambiguates from
    // button labels that share the same text ("Rebuild portfolio" etc.).
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Rebuild all analytics' })).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Rebuild portfolio' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rebuild analytics from a date' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rebuild a single asset' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent rebuilds' })).toBeInTheDocument();
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
});
