import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import SubscriptionsPage from './subscriptions';
import * as UseSubs from '@/hooks/use-subscriptions';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';
import type { SubscriptionsResponse, SubscriptionItem } from '@/types/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.count != null ? `${k}:${o.count}` : k), i18n: { language: 'en' } }),
}));

vi.mock('@/hooks/use-subscriptions');
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

// jsdom stubs for Radix Select
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

function baseResponse(
  items: SubscriptionItem[],
  mergeCandidates: SubscriptionsResponse['mergeCandidates'] = [],
): SubscriptionsResponse {
  return {
    displayCurrency: 'USD',
    lastDetectedAt: null,
    fullScanAt: '2026-01-01T00:00:00.000Z',
    refreshCooldownSeconds: 0,
    categories: [{ id: 10, name: 'Media', icon: '📺', count: items.length }],
    mergeCandidates,
    summary: {
      monthlyTotal: 21,
      annualTotal: 252,
      activeCount: items.length,
      lapsedCount: 0,
      fxUnavailableCount: 0,
      mergedCount: 0,
    },
    items,
  };
}

function makeItem(over: Partial<SubscriptionItem> = {}): SubscriptionItem {
  return {
    id: 1,
    descriptionHash: 'hash-1',
    merchantLabel: 'Netflix',
    categoryId: 10,
    category: { id: 10, name: 'Media', icon: '📺' },
    state: 'DETECTED',
    cadence: 'MONTHLY',
    userCadenceLocked: false,
    status: 'ACTIVE',
    detectionReason: 'CATEGORY_SIGNAL',
    amount: 15.99,
    currency: 'USD',
    amountInDisplayCurrency: 15.99,
    monthlyAmount: 15.99,
    fxUnavailable: false,
    occurrenceCount: 3,
    firstChargedAt: null,
    lastChargedAt: '2026-08-01T00:00:00.000Z',
    nextExpectedAt: '2026-09-01T00:00:00.000Z',
    lastDetectedAt: '2026-08-15T00:00:00.000Z',
    contributingTransactionIds: [1, 2, 3],
    userLabelLocked: false,
    mergedIntoHash: null,
    mergedIntoLabel: null,
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SubscriptionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const confirmMutate = vi.fn();
const renameMutate = vi.fn();
const mergeMutate = vi.fn();
const unmergeMutate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(UseSubs.useConfirmSubscription).mockReturnValue(mockMutationResult({ mutate: confirmMutate }));
  vi.mocked(UseSubs.useDismissSubscription).mockReturnValue(mockMutationResult({ mutate: vi.fn() }));
  vi.mocked(UseSubs.useRestoreSubscription).mockReturnValue(mockMutationResult({ mutate: vi.fn() }));
  vi.mocked(UseSubs.useSetSubscriptionCadence).mockReturnValue(mockMutationResult({ mutate: vi.fn() }));
  vi.mocked(UseSubs.useRenameSubscription).mockReturnValue(mockMutationResult({ mutate: renameMutate }));
  vi.mocked(UseSubs.useMergeSubscription).mockReturnValue(mockMutationResult({ mutate: mergeMutate }));
  vi.mocked(UseSubs.useUnmergeSubscription).mockReturnValue(mockMutationResult({ mutate: unmergeMutate }));
  vi.mocked(UseSubs.useRefreshSubscriptions).mockReturnValue(mockMutationResult({ mutate: vi.fn() }));
});

describe('SubscriptionsPage', () => {
  it('shows the empty state when there are no items', () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(mockQueryResult(baseResponse([])));
    renderPage();
    expect(screen.getByText('subscriptions.empty.title')).toBeInTheDocument();
    expect(screen.queryByText('Netflix')).not.toBeInTheDocument();
  });

  it('renders one row per detected merchant with its cadence label', () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(mockQueryResult(baseResponse([makeItem()])));
    renderPage();
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('subscriptions.cadence.MONTHLY')).toBeInTheDocument();
    // summary keys rendered
    expect(screen.getByText('subscriptions.summary.monthly')).toBeInTheDocument();
  });

  it('does not render skeletons once data has loaded', () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(mockQueryResult(baseResponse([makeItem()])));
    const { container } = renderPage();
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0);
  });

  it('confirm button fires the confirm mutation with the merchant hash', async () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(mockQueryResult(baseResponse([makeItem()])));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /subscriptions\.confirm/i }));
    await waitFor(() => {
      expect(confirmMutate).toHaveBeenCalledWith(
        { descriptionHash: 'hash-1' },
        expect.any(Object),
      );
    });
  });

  it('shows the "Remove" action for a CONFIRMED row', () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(
      mockQueryResult(baseResponse([makeItem({ state: 'CONFIRMED' })])),
    );
    renderPage();
    expect(screen.getByRole('button', { name: /subscriptions\.remove/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscriptions\.confirm/i })).not.toBeInTheDocument();
  });

  it('renaming a row fires the rename mutation with the new label', async () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(mockQueryResult(baseResponse([makeItem()])));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'subscriptions.rename.label' }));
    const input = screen.getByRole('textbox', { name: 'subscriptions.rename.label' });
    fireEvent.change(input, { target: { value: 'Netflix Family' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(renameMutate).toHaveBeenCalledWith(
        { descriptionHash: 'hash-1', merchantLabel: 'Netflix Family' },
        expect.any(Object),
      );
    });
  });

  it('marks a row with a custom name', () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(
      mockQueryResult(baseResponse([makeItem({ userLabelLocked: true })])),
    );
    renderPage();
    expect(screen.getByText(/subscriptions\.rename\.custom/)).toBeInTheDocument();
  });

  it('merge button fires the merge mutation with source + target hashes (target from a hidden view)', async () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(
      mockQueryResult(
        baseResponse(
          [makeItem({ id: 2, descriptionHash: 'hash-2', merchantLabel: 'To Orange Espagne S.a.', status: 'LAPSED' })],
          // "Orange" is an Active/Confirmed row the Lapsed view doesn't list — still a candidate
          [
            { descriptionHash: 'hash-1', merchantLabel: 'Orange', status: 'ACTIVE', state: 'CONFIRMED', categoryIcon: '📺', categoryName: 'Media' },
            { descriptionHash: 'hash-2', merchantLabel: 'To Orange Espagne S.a.', status: 'LAPSED', state: 'DETECTED', categoryIcon: null, categoryName: null },
          ],
        ),
      ),
    );
    renderPage();
    // merge action lives in the row's button cluster — no need to expand
    fireEvent.click(screen.getByRole('button', { name: 'subscriptions.merge.mergeInto' }));
    const combos = screen.getAllByRole('combobox');
    fireEvent.click(combos[combos.length - 1]); // the merge picker is the last Select on the page
    fireEvent.click(screen.getByRole('option', { name: /Orange/ }));
    await waitFor(() => {
      expect(mergeMutate).toHaveBeenCalledWith(
        { sourceDescriptionHash: 'hash-2', targetDescriptionHash: 'hash-1' },
        expect.any(Object),
      );
    });
  });

  it('disables the merge button when there is no other candidate', () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(
      mockQueryResult(
        baseResponse([makeItem({ descriptionHash: 'hash-1' })], [
          { descriptionHash: 'hash-1', merchantLabel: 'Netflix', status: 'ACTIVE', state: 'DETECTED', categoryIcon: null, categoryName: null },
        ]),
      ),
    );
    renderPage();
    expect(screen.getByRole('button', { name: 'subscriptions.merge.mergeInto' })).toBeDisabled();
  });

  it('shows a "N merged — manage" shortcut on non-all views and it jumps to All', () => {
    const resp = baseResponse([makeItem()]);
    resp.summary.mergedCount = 2;
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(mockQueryResult(resp));
    renderPage();
    const hint = screen.getByRole('button', { name: /subscriptions\.merge\.mergedCountHint/ });
    expect(hint).toBeInTheDocument();
    fireEvent.click(hint);
    // view is now "all" → the shortcut hides itself
    expect(screen.queryByRole('button', { name: /subscriptions\.merge\.mergedCountHint/ })).not.toBeInTheDocument();
  });

  it('shows the Unmerge action for a merged tombstone under the All view', () => {
    vi.mocked(UseSubs.useSubscriptions).mockReturnValue(
      mockQueryResult(
        baseResponse([
          makeItem({
            descriptionHash: 'hash-2',
            merchantLabel: 'To Orange Espagne S.a.',
            mergedIntoHash: 'hash-1',
            mergedIntoLabel: 'Orange',
          }),
        ]),
      ),
    );
    renderPage();
    expect(screen.getByRole('button', { name: /subscriptions\.merge\.unmerge/i })).toBeInTheDocument();
    expect(screen.getByText('Orange')).toBeInTheDocument();
  });
});
