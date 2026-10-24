import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { EtoroSection } from './etoro-section';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));
// Radix Select in jsdom.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const CONNECTION = {
  id: 'c1', etoroUsername: 'BlissUser', accountId: 3, account: { id: 3, name: 'eToro' }, keyLast4: '1234',
  scopes: ['trade.real:read'], status: 'ACTIVE', errorCode: null, connectedAt: '2026-10-20T00:00:00Z',
  lastSyncAt: '2026-10-21T03:30:00Z', lastSyncStatus: 'SUCCESS', lastSyncError: null,
  copies: [
    { id: 'p1', parentUsername: 'topinvestor', startedAt: '2026-03-01T00:00:00Z', status: 'ACTIVE', closedAt: null, lastValue: 2500, lastValueCurrency: 'USD', lastValueAt: null, cashPct: 5, unmappedPct: 0, holdingsCount: 20, linkedHolding: { id: 7, symbol: 'topinvestor' } },
    { id: 'p2', parentUsername: 'other', startedAt: null, status: 'CLOSED', closedAt: '2026-10-01T00:00:00Z', lastValue: 100, lastValueCurrency: 'USD', lastValueAt: null, cashPct: 0, unmappedPct: 0, holdingsCount: 1, linkedHolding: null },
  ],
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><EtoroSection /></QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe('EtoroSection (#143)', () => {
  it('shows the empty state', async () => {
    server.use(http.get('/api/etoro/connections', () => HttpResponse.json({ connections: [] })));
    renderSection();
    expect(await screen.findByTestId('etoro-empty')).toBeInTheDocument();
  });

  it('lists a connection with its copies, link state and masked key', async () => {
    server.use(http.get('/api/etoro/connections', () => HttpResponse.json({ connections: [CONNECTION] })));
    renderSection();
    const card = await screen.findByTestId('etoro-connection-c1');
    expect(within(card).getByTestId('etoro-connection-status')).toHaveTextContent('etoro.status.ACTIVE');
    expect(card).toHaveTextContent('••••1234');
    expect(within(card).getByTestId('etoro-copy-p1')).toHaveTextContent('etoro.copy.linkedTo {"symbol":"topinvestor"}');
    expect(within(card).getByTestId('etoro-copy-p2')).toHaveTextContent('etoro.copy.closed');
    expect(within(card).getByTestId('etoro-copy-p2')).toHaveTextContent('etoro.copy.notLinked');
  });

  it('"Sync now" reports the cooldown', async () => {
    server.use(
      http.get('/api/etoro/connections', () => HttpResponse.json({ connections: [CONNECTION] })),
      http.post('/api/etoro/connections/c1/sync', () => HttpResponse.json({ code: 'COOLDOWN', retryAfter: 600 }, { status: 429 })),
    );
    renderSection();
    fireEvent.click(await screen.findByText('etoro.connection.syncNow'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'etoro.connection.cooldown {"minutes":10}' })));
  });

  it('connects an account: refuses a write key, then shows the username and copies', async () => {
    let calls = 0;
    server.use(
      http.get('/api/etoro/connections', () => HttpResponse.json({ connections: [] })),
      http.get('/api/accounts', () => HttpResponse.json({ accounts: [{ id: 3, name: 'eToro' }], total: 1 })),
      http.post('/api/etoro/connections', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: 'ETORO_WRITE_SCOPE', writeScopes: ['trade.real:write'] }, { status: 400 })
          : HttpResponse.json({ connection: CONNECTION, copies: [{ parentUsername: 'topinvestor', startedAt: null, value: 2500, currency: 'USD' }] }, { status: 201 });
      }),
    );
    renderSection();
    fireEvent.click(await screen.findByText('etoro.section.connect'));
    fireEvent.change(screen.getByLabelText('etoro.dialog.apiKey'), { target: { value: 'pub' } });
    fireEvent.change(screen.getByLabelText('etoro.dialog.userKey'), { target: { value: 'secret' } });
    // The account picker (Radix select): pick the only account.
    fireEvent.click(screen.getByRole('combobox', { name: 'etoro.dialog.account' }));
    fireEvent.click(await screen.findByRole('option', { name: 'eToro' }));

    fireEvent.click(screen.getByText('etoro.dialog.submit'));
    expect(await screen.findByTestId('etoro-connect-error')).toHaveTextContent('etoro.errors.ETORO_WRITE_SCOPE');

    fireEvent.click(screen.getByText('etoro.dialog.submit'));
    const result = await screen.findByTestId('etoro-connect-result');
    expect(result).toHaveTextContent('etoro.dialog.successTitle {"username":"BlissUser"}');
    expect(result).toHaveTextContent('@topinvestor');
  });
});
