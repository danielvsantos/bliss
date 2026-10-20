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

const onOpenChange = vi.fn();

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConvertToCopyTradingModal asset={{ id: 5, symbol: 'Funds:Copy of TopInvestor' }} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

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
