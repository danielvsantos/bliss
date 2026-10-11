import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { useAuth } from '@/hooks/use-auth';
import type { PlaidItem } from '@/types/api';
import { BankConnectionCard } from './bank-connection-card';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-auth');

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

function makeItem(overrides: Partial<PlaidItem> = {}): PlaidItem {
  return {
    id: 'item-1',
    itemId: 'eb_x',
    status: 'ACTIVE',
    historicalSyncComplete: true,
    institutionName: 'Banco Uno',
    consentExpiration: inDays(100),
    lastSync: '2026-10-10T08:00:00.000Z',
    provider: 'ENABLE_BANKING',
    aspspCountry: 'ES',
    userId: 'u1',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function setUser(id: string, role: 'admin' | 'member' | 'viewer' = 'member') {
  vi.mocked(useAuth).mockReturnValue({ user: { id, email: 'u@test', role } } as unknown as ReturnType<typeof useAuth>);
}

/** The connection GET is not needed for status; answer 404 so the card uses the item. */
function noDetails() {
  server.use(http.get('/api/enablebanking/connections/item-1', () => HttpResponse.json({}, { status: 404 })));
}

function renderCard(item: PlaidItem, onOpenMapping = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BankConnectionCard item={item} onOpenMapping={onOpenMapping} />
    </QueryClientProvider>,
  );
  return onOpenMapping;
}

const assign = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  setUser('u1');
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign } });
});
afterEach(() => Object.defineProperty(window, 'location', { configurable: true, value: originalLocation }));

describe('BankConnectionCard (#132) — status badge', () => {
  beforeEach(noDetails);

  it('Active (positive) when the consent is far from expiry', () => {
    renderCard(makeItem());
    const badge = screen.getByTestId('eb-status-badge');
    expect(badge).toHaveAttribute('data-state', 'active');
    expect(badge).toHaveTextContent('enableBanking.card.statusActive');
    expect(badge.className).toContain('text-positive');
  });

  it('Expiring (warning) within 14 days of the consent expiry', () => {
    renderCard(makeItem({ consentExpiration: inDays(5) }));
    const badge = screen.getByTestId('eb-status-badge');
    expect(badge).toHaveAttribute('data-state', 'expiring');
    expect(badge).toHaveTextContent('enableBanking.card.statusExpiring');
    expect(badge.className).toContain('text-warning');
    expect(screen.getByText('enableBanking.card.expiringDesc')).toBeInTheDocument();
  });

  it('Expired (destructive) for LOGIN_REQUIRED, with Reconnect but no Sync now', () => {
    renderCard(makeItem({ status: 'LOGIN_REQUIRED', consentExpiration: inDays(-1) }));
    const badge = screen.getByTestId('eb-status-badge');
    expect(badge).toHaveAttribute('data-state', 'expired');
    expect(badge).toHaveTextContent('enableBanking.card.statusExpired');
    expect(badge.className).toContain('text-destructive');
    expect(screen.getByRole('button', { name: /enableBanking\.card\.reconnect/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /enableBanking\.card\.syncNow/ })).not.toBeInTheDocument();
  });

  it('Disconnected (muted) for REVOKED, with no Sync now or Disconnect', () => {
    renderCard(makeItem({ status: 'REVOKED' }));
    const badge = screen.getByTestId('eb-status-badge');
    expect(badge).toHaveAttribute('data-state', 'disconnected');
    expect(badge).toHaveTextContent('enableBanking.card.statusDisconnected');
    expect(badge.className).toContain('text-muted-foreground');
    expect(screen.queryByRole('button', { name: /enableBanking\.card\.syncNow/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enableBanking\.card\.disconnect$/ })).not.toBeInTheDocument();
  });

  it('Needs mapping (warning) opens the mapping dialog', () => {
    const onOpenMapping = renderCard(makeItem({ status: 'PENDING_SELECTION' }));
    expect(screen.getByTestId('eb-status-badge')).toHaveAttribute('data-state', 'needsMapping');
    fireEvent.click(screen.getByRole('button', { name: /enableBanking\.card\.mapAccounts/ }));
    expect(onOpenMapping).toHaveBeenCalledWith('item-1');
  });
});

describe('BankConnectionCard (#132) — actions', () => {
  it('shows the bank-imposed reset time when Sync now hits 429 SYNC_BUDGET_EXHAUSTED', async () => {
    noDetails();
    server.use(
      http.post('/api/enablebanking/connections/item-1/sync', () =>
        HttpResponse.json(
          { code: 'SYNC_BUDGET_EXHAUSTED', resetsAt: '2026-10-12T00:00:00.000Z', error: 'x' },
          { status: 429 },
        ),
      ),
    );
    renderCard(makeItem());

    fireEvent.click(screen.getByRole('button', { name: /enableBanking\.card\.syncNow/ }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const call = toast.mock.calls[0][0] as { title: string; description: string; variant: string };
    expect(call.title).toBe('enableBanking.card.budgetTitle');
    expect(call.description).toMatch(/^enableBanking\.card\.budgetDesc \{"time":".*2026.*"\}$/);
    expect(call.variant).toBe('destructive');
  });

  it('reconnect is only enabled for the authorising user and explains who must do it', () => {
    noDetails();
    setUser('someone-else', 'admin');
    renderCard(makeItem({ status: 'LOGIN_REQUIRED' }));

    expect(screen.getByRole('button', { name: /enableBanking\.card\.reconnect/ })).toBeDisabled();
    expect(screen.getByText('enableBanking.card.reconnectOnlyAuthoriser')).toBeInTheDocument();
    // An admin may still disconnect.
    expect(screen.getByRole('button', { name: /enableBanking\.card\.disconnect$/ })).toBeEnabled();
  });

  it('a member who did not authorise the connection cannot disconnect it', () => {
    noDetails();
    setUser('someone-else', 'member');
    renderCard(makeItem());
    expect(screen.getByRole('button', { name: /enableBanking\.card\.disconnect$/ })).toBeDisabled();
    expect(screen.getByText('enableBanking.card.disconnectOnlyAdmin')).toBeInTheDocument();
  });

  it('reconnect starts a consent for this connection and navigates to the bank', async () => {
    noDetails();
    let body: unknown = null;
    server.use(
      http.post('/api/enablebanking/connect', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ url: 'https://bank.test/renew', startDate: '2026-10-01' });
      }),
    );
    renderCard(makeItem({ consentExpiration: inDays(3) }));

    fireEvent.click(screen.getByRole('button', { name: /enableBanking\.card\.reconnect/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://bank.test/renew'));
    expect(body).toEqual({ reconnectItemId: 'item-1' });
  });

  it('shows the latest balance of each mapped bank account', async () => {
    server.use(
      http.get('/api/enablebanking/connections/item-1', () =>
        HttpResponse.json({
          connection: {
            id: 'item-1', institutionName: 'Banco Uno', aspspCountry: 'ES', status: 'ACTIVE',
            consentExpiration: inDays(100), lastSync: '2026-10-10T08:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z',
            authorizedByMe: true,
          },
          startDate: '2026-10-01',
          accounts: [{
            id: 'eb-1', name: 'Cuenta', ibanLast4: '0123', currency: 'EUR', accountId: 10, suggestedAccountId: 10,
            conflict: false, lastBalance: '1234.50', lastBalanceCurrency: 'EUR', lastBalanceAt: '2026-10-10T08:00:00.000Z',
          }],
          blissAccounts: [],
        }),
      ),
    );
    renderCard(makeItem());

    expect(await screen.findByTestId('eb-balance-eb-1')).toHaveTextContent('€1,234.50');
    expect(screen.getByText('Cuenta •••• 0123')).toBeInTheDocument();
  });
});
