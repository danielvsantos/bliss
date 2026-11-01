import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { useAuth } from '@/hooks/use-auth';
import { EnableBankingConnect, EnableBankingConnectDialog } from './connect-dialog';
import api from '@/lib/api';

// Echo keys; fold interpolation values in so assertions can see them.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-auth');
let standalone = false;
vi.mock('@/hooks/use-display-mode', () => ({ useIsStandalone: () => standalone }));

const assign = vi.fn();
const originalLocation = window.location;

const ASPSPS = {
  aspsps: [
    { name: 'Banco Uno', country: 'ES', logo: null, maximumConsentValiditySec: 180 * 86400 },
    { name: 'Banque Deux', country: 'FR', logo: 'https://example.test/logo.png', maximumConsentValiditySec: null },
  ],
  startDate: '2026-03-01',
};

let statusCalls = 0;
let connectBody: unknown = null;

function setRole(role: 'admin' | 'member' | 'viewer') {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 'u1', email: 'u@test', role },
  } as unknown as ReturnType<typeof useAuth>);
}

function useHandlers({ enabled = true, connectStatus = 200, connectResponse = { url: 'https://bank.test/auth', startDate: '2026-03-01' } as object } = {}) {
  server.use(
    http.get('/api/enablebanking/status', () => {
      statusCalls += 1;
      return HttpResponse.json({ enabled });
    }),
    http.get('/api/enablebanking/aspsps', () => HttpResponse.json(ASPSPS)),
    http.post('/api/enablebanking/connect', async ({ request }) => {
      connectBody = await request.json();
      return HttpResponse.json(connectResponse, { status: connectStatus });
    }),
  );
}

function renderConnect() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EnableBankingConnect />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  statusCalls = 0;
  connectBody = null;
  setRole('admin');
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign } });
});
afterEach(() => Object.defineProperty(window, 'location', { configurable: true, value: originalLocation }));

describe('EnableBankingConnect (#132)', () => {
  it('renders nothing when Enable Banking is not configured', async () => {
    useHandlers({ enabled: false });
    const { container } = renderConnect();
    await waitFor(() => expect(statusCalls).toBe(1));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('enableBanking.connect.button')).not.toBeInTheDocument();
  });

  it('renders the button when Enable Banking is configured', async () => {
    useHandlers({ enabled: true });
    renderConnect();
    expect(await screen.findByRole('button', { name: /enableBanking\.connect\.button/ })).toBeInTheDocument();
  });

  it('is hidden for viewers (and does not even ask for the status)', async () => {
    setRole('viewer');
    useHandlers({ enabled: true });
    const { container } = renderConnect();
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(statusCalls).toBe(0);
  });

  it('shows the import start date before the user continues, grouped by country', async () => {
    useHandlers();
    renderConnect();
    fireEvent.click(await screen.findByRole('button', { name: /enableBanking\.connect\.button/ }));

    const notice = await screen.findByTestId('eb-start-date');
    expect(notice).toHaveTextContent('enableBanking.connect.startDate');
    expect(notice).toHaveTextContent(/2026/);
    expect(notice).toHaveTextContent(/Mar/);

    // Banks listed under their (localised) country headers.
    expect(screen.getByText('Spain')).toBeInTheDocument();
    expect(screen.getByText('France')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Banco Uno' })).toBeInTheDocument();

    // Continue stays disabled until a bank is picked; nothing navigates yet.
    expect(screen.getByRole('button', { name: 'enableBanking.connect.continue' })).toBeDisabled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('filters banks by name', async () => {
    useHandlers();
    renderConnect();
    fireEvent.click(await screen.findByRole('button', { name: /enableBanking\.connect\.button/ }));
    await screen.findByRole('option', { name: 'Banco Uno' });

    fireEvent.change(screen.getByLabelText('enableBanking.connect.search'), { target: { value: 'deux' } });
    expect(screen.queryByRole('option', { name: 'Banco Uno' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Banque Deux' })).toBeInTheDocument();
  });

  it('continuing calls connect with the bank and navigates to the returned URL', async () => {
    useHandlers();
    renderConnect();
    fireEvent.click(await screen.findByRole('button', { name: /enableBanking\.connect\.button/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Banco Uno' }));

    // The selected bank's consent length is shown.
    expect(screen.getByTestId('eb-start-date')).toHaveTextContent('enableBanking.connect.consentDays {"count":180}');

    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.connect.continue' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://bank.test/auth'));
    expect(connectBody).toEqual({ aspspName: 'Banco Uno', aspspCountry: 'ES' });
  });

  it('shows a specific error for COUNTRY_NOT_ENABLED and does not navigate', async () => {
    useHandlers({ connectStatus: 400, connectResponse: { code: 'COUNTRY_NOT_ENABLED', error: 'x' } });
    renderConnect();
    fireEvent.click(await screen.findByRole('button', { name: /enableBanking\.connect\.button/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Banco Uno' }));
    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.connect.continue' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'enableBanking.connect.errorCountryNotEnabled', variant: 'destructive' }),
      ),
    );
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('EnableBankingConnectDialog onBeforeRedirect (#154)', () => {
  function renderDialog(onBeforeRedirect?: () => Promise<void>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <EnableBankingConnectDialog open onOpenChange={() => {}} onBeforeRedirect={onBeforeRedirect} />
      </QueryClientProvider>,
    );
  }

  async function pickAndContinue() {
    fireEvent.click(await screen.findByRole('option', { name: 'Banco Uno' }));
    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.connect.continue' }));
  }

  it('awaits onBeforeRedirect before leaving for the bank', async () => {
    useHandlers();
    const order: string[] = [];
    let release: () => void = () => {};
    const onBeforeRedirect = vi.fn(() => new Promise<void>((resolve) => {
      order.push('before');
      release = () => { order.push('released'); resolve(); };
    }));
    assign.mockImplementation(() => order.push('assign'));
    renderDialog(onBeforeRedirect);
    await pickAndContinue();

    await waitFor(() => expect(onBeforeRedirect).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://bank.test/auth'));
    expect(order).toEqual(['before', 'released', 'assign']);
  });

  it('still redirects when onBeforeRedirect rejects', async () => {
    useHandlers();
    const onBeforeRedirect = vi.fn(() => Promise.reject(new Error('boom')));
    renderDialog(onBeforeRedirect);
    await pickAndContinue();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://bank.test/auth'));
  });

  it('does not call onBeforeRedirect when connect fails', async () => {
    useHandlers({ connectStatus: 400, connectResponse: { code: 'UNKNOWN_ASPSP', error: 'x' } });
    const onBeforeRedirect = vi.fn(() => Promise.resolve());
    renderDialog(onBeforeRedirect);
    await pickAndContinue();
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(onBeforeRedirect).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('without onBeforeRedirect (Accounts page) writes no onboarding steps', async () => {
    useHandlers();
    const spy = vi.spyOn(api, 'completeOnboardingStep');
    renderDialog();
    await pickAndContinue();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://bank.test/auth'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('EnableBankingConnect in the installed app (#155)', () => {
  afterEach(() => {
    standalone = false;
  });

  it('renders nothing (the PlaidConnect note covers the page)', async () => {
    useHandlers();
    setRole('admin');
    standalone = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <EnableBankingConnect />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));
    expect(container).toBeEmptyDOMElement();
  });
});
