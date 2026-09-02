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

function baseResponse(items: SubscriptionItem[]): SubscriptionsResponse {
  return {
    displayCurrency: 'USD',
    lastDetectedAt: null,
    fullScanAt: '2026-01-01T00:00:00.000Z',
    refreshCooldownSeconds: 0,
    categories: [{ id: 10, name: 'Media', icon: '📺', count: items.length }],
    summary: {
      monthlyTotal: 21,
      annualTotal: 252,
      activeCount: items.length,
      lapsedCount: 0,
      fxUnavailableCount: 0,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(UseSubs.useConfirmSubscription).mockReturnValue(mockMutationResult({ mutate: confirmMutate }));
  vi.mocked(UseSubs.useDismissSubscription).mockReturnValue(mockMutationResult({ mutate: vi.fn() }));
  vi.mocked(UseSubs.useRestoreSubscription).mockReturnValue(mockMutationResult({ mutate: vi.fn() }));
  vi.mocked(UseSubs.useSetSubscriptionCadence).mockReturnValue(mockMutationResult({ mutate: vi.fn() }));
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
});
