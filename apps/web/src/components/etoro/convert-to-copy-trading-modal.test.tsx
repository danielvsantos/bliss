import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { ConvertToCopyTradingModal } from './convert-to-copy-trading-modal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

// Radix RadioGroup measures its items.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const onOpenChange = vi.fn();

function renderModal(asset: { id: number; symbol: string; accountId?: number | null } = { id: 5, symbol: 'Funds:Copy of TopInvestor' }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConvertToCopyTradingModal asset={asset} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

const copy = (parentUsername: string, linkedHolding: { id: number; symbol: string } | null = null) => ({
  id: parentUsername, parentUsername, startedAt: null, status: 'ACTIVE', closedAt: null, lastValue: 1000, lastValueCurrency: 'USD',
  lastValueAt: null, cashPct: null, unmappedPct: null, holdingsCount: 10, linkedHolding,
});
const connections = (accountId: number, copies: ReturnType<typeof copy>[]) => [{
  id: 'c1', etoroUsername: 'me', accountId, account: { id: accountId, name: 'eToro' }, keyLast4: '1234', scopes: [],
  status: 'ACTIVE', errorCode: null, connectedAt: '', lastSyncAt: null, lastSyncStatus: null, lastSyncError: null, copies,
}];

beforeEach(() => {
  vi.clearAllMocks();
  server.use(http.get('/api/etoro/connections', () => HttpResponse.json({ connections: [] })));
});

describe('ConvertToCopyTradingModal (#143)', () => {
  it('needs a valid username, sends it normalized and closes on success', async () => {
    let body: unknown = null;
    server.use(http.post('/api/etoro/convert-holding', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ portfolioItemId: 5, symbol: 'topinvestor', categoryId: 9, transactionsMoved: 1 });
    }));
    renderModal();
    const submit = screen.getByText('etoro.convert.submit').closest('button')!;
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('etoro.convert.username'), { target: { value: ' @TopInvestor ' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(body).toEqual({ portfolioItemId: 5, etoroUsername: 'topinvestor' });
    expect(toast).toHaveBeenCalledWith({ title: 'etoro.convert.success {"symbol":"topinvestor"}' });
  });

  it('offers the account\'s unlinked copies, preselecting the one named in the holding', async () => {
    let body: unknown = null;
    server.use(
      http.get('/api/etoro/connections', () => HttpResponse.json({
        connections: connections(7, [copy('amitkup'), copy('zed'), copy('taken', { id: 1, symbol: 'taken' })]),
      })),
      http.post('/api/etoro/convert-holding', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ portfolioItemId: 5, symbol: 'amitkup', categoryId: 9, transactionsMoved: 2 });
      }),
    );
    renderModal({ id: 5, symbol: 'Copy Traders:AmitKup (Amit Kupfer)', accountId: 7 });

    const picked = await screen.findByRole('radio', { name: /@amitkup/ });
    await waitFor(() => expect(picked).toBeChecked());
    expect(screen.queryByRole('radio', { name: /@taken/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('etoro.convert.username')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('etoro.convert.submit'));
    await waitFor(() => expect(body).toEqual({ portfolioItemId: 5, etoroUsername: 'amitkup' }));
  });

  it('still lets the user type another investor', async () => {
    server.use(http.get('/api/etoro/connections', () => HttpResponse.json({ connections: connections(7, [copy('zed')]) })));
    renderModal({ id: 5, symbol: 'Funds:eToro copy - Daniel Santos', accountId: 7 });
    fireEvent.click(await screen.findByRole('radio', { name: 'etoro.convert.otherInvestor' }));
    expect(await screen.findByLabelText('etoro.convert.username')).toBeInTheDocument();
    expect(screen.getByText('etoro.convert.submit').closest('button')).toBeDisabled();
  });

  it('warns when the eToro connection uses another account', async () => {
    server.use(http.get('/api/etoro/connections', () => HttpResponse.json({ connections: connections(7, [copy('zed')]) })));
    renderModal({ id: 5, symbol: 'Copy Traders:zed', accountId: 9 });
    expect(await screen.findByTestId('convert-other-account')).toHaveTextContent('etoro.convert.otherAccount');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('explains a clash with an existing copy holding', async () => {
    server.use(http.post('/api/etoro/convert-holding', () =>
      HttpResponse.json({ code: 'COPY_HOLDING_EXISTS' }, { status: 409 })));
    renderModal();
    fireEvent.change(screen.getByLabelText('etoro.convert.username'), { target: { value: 'topinvestor' } });
    fireEvent.click(screen.getByText('etoro.convert.submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('etoro.convert.errors.COPY_HOLDING_EXISTS');
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
