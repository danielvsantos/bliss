/**
 * Onboarding step 2 bank providers (#154): both options always shown in a fixed
 * order, the Plaid states driven by the link-token call, Enable Banking setup
 * handing straight off to the bank picker, and completion recorded before the
 * bank redirect only.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import type { EnableBankingCredentialsView } from '@/types/api';
import { BankProviderOptions } from './bank-provider-options';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));
const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));
let standalone = false;
vi.mock('@/hooks/use-display-mode', () => ({ useIsStandalone: () => standalone }));
vi.mock('react-plaid-link', () => ({
  usePlaidLink: vi.fn((config: { token: string | null }) => ({ open: vi.fn(), ready: !!config.token })),
}));
vi.mock('@/components/account-selection-modal', () => ({ AccountSelectionModal: () => null }));

const KEYS_DIR = join(__dirname, '../../../../../packages/shared/test-fixtures/enablebanking-keys');
const PEM = readFileSync(join(KEYS_DIR, 'rsa2048-pkcs8.pem'), 'utf8');
const APP_ID = '6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const C = 'onboarding.connect';

const EMPTY: EnableBankingCredentialsView = {
  configured: false,
  callbackUrl: 'https://api.example.test/api/enablebanking/callback',
  credential: null,
  usage: { activeConnections: 0, pausedConnections: 0, linkedAccounts: 0, limit: 5 },
  history: [],
};
const saved = (status: 'VERIFIED' | 'UNVERIFIED'): EnableBankingCredentialsView => ({
  ...EMPTY,
  configured: true,
  credential: {
    appId: APP_ID,
    keyFingerprint: 'SHA256:abc',
    keyBits: 2048,
    status,
    lastValidatedAt: null,
    callbackRegistered: true,
    updatedAt: '2026-10-18T10:00:00.000Z',
  },
});

let ebEnabled: boolean;
let configurable: boolean;
let linkTokenCalls: number;
const assign = vi.fn();
const originalLocation = window.location;

function useApi({
  linkToken = 'ok' as 'ok' | 'not_configured' | 'error',
  saveStatus = 'VERIFIED' as 'VERIFIED' | 'UNVERIFIED',
} = {}) {
  server.use(
    http.post('/api/plaid/create-link-token', () => {
      linkTokenCalls += 1;
      if (linkToken === 'not_configured') {
        return HttpResponse.json({ error: 'Plaid is not configured', code: 'PLAID_NOT_CONFIGURED' }, { status: 503 });
      }
      if (linkToken === 'error') return HttpResponse.json({ error: 'Server Error' }, { status: 500 });
      return HttpResponse.json({ link_token: 'link-123', expiration: 'x' });
    }),
    http.get('/api/enablebanking/status', () =>
      HttpResponse.json({ enabled: ebEnabled, configurable, pausedConnections: 0 }),
    ),
    http.get('/api/enablebanking/credentials', () => HttpResponse.json(EMPTY)),
    http.put('/api/enablebanking/credentials', () => {
      ebEnabled = true;
      return HttpResponse.json(saved(saveStatus), { status: 201 });
    }),
    http.get('/api/enablebanking/aspsps', () =>
      HttpResponse.json({
        aspsps: [{ name: 'Revolut', country: 'ES', logo: null, maximumConsentValiditySec: null }],
        startDate: '2026-03-01',
      }),
    ),
    http.post('/api/enablebanking/connect', () => HttpResponse.json({ url: 'https://bank.test/auth', startDate: '2026-03-01' })),
  );
}

function renderOptions(props: Partial<React.ComponentProps<typeof BankProviderOptions>> = {}) {
  const onPlaidComplete = vi.fn(() => Promise.resolve());
  const onEnableBankingRedirect = vi.fn(() => Promise.resolve());
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BankProviderOptions onPlaidComplete={onPlaidComplete} onEnableBankingRedirect={onEnableBankingRedirect} {...props} />
    </QueryClientProvider>,
  );
  return { onPlaidComplete, onEnableBankingRedirect, queryClient };
}

async function fillAndSave() {
  fireEvent.change(await screen.findByLabelText('enableBanking.credentials.appIdLabel'), { target: { value: APP_ID } });
  fireEvent.click(screen.getByRole('button', { name: 'enableBanking.keyInput.pasteInstead' }));
  fireEvent.change(screen.getByTestId('eb-key-textarea'), { target: { value: PEM } });
  fireEvent.click(screen.getByRole('button', { name: 'enableBanking.credentials.save' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  ebEnabled = false;
  configurable = true;
  linkTokenCalls = 0;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign } });
});
afterEach(() => {
  standalone = false;
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('BankProviderOptions — layout and states (R1)', () => {
  it('new admin, Plaid configured, no EU credentials: both options with equal weight, Plaid first', async () => {
    useApi();
    renderOptions();
    const plaid = screen.getByTestId('provider-plaid');
    const eb = screen.getByTestId('provider-enable-banking');
    // Fixed order and identical card styling.
    expect(plaid.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plaid.className).toBe(eb.className);
    expect(within(plaid).getByText(`${C}.plaid.title`)).toBeInTheDocument();
    expect(within(eb).getByText(`${C}.enableBanking.title`)).toBeInTheDocument();
    await waitFor(() => expect(within(plaid).getByRole('button', { name: `${C}.plaid.button` })).toBeEnabled());
    expect(await within(eb).findByRole('button', { name: `${C}.enableBanking.setup` })).toBeInTheDocument();
    // Both have a guide link.
    expect(within(plaid).getByRole('link', { name: `${C}.learnMore` })).toHaveAttribute('href', expect.stringContaining('plaid-bank-sync'));
    expect(within(eb).getByRole('link', { name: `${C}.learnMore` })).toHaveAttribute('href', expect.stringContaining('enable-banking'));
  });

  it('Plaid not configured on the server: explanatory state, no dead button, a single request', async () => {
    useApi({ linkToken: 'not_configured' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderOptions();
    const plaid = screen.getByTestId('provider-plaid');
    expect(await within(plaid).findByTestId('plaid-not-configured')).toHaveTextContent(`${C}.plaid.notConfigured`);
    expect(within(plaid).queryByRole('button')).not.toBeInTheDocument();
    expect(within(plaid).getByRole('link', { name: `${C}.learnMore` })).toBeInTheDocument();
    expect(linkTokenCalls).toBe(1);
    vi.mocked(console.error).mockRestore();
  });

  it('other link-token failure: "couldn\'t reach Plaid" hint', async () => {
    useApi({ linkToken: 'error' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderOptions();
    expect(await screen.findByTestId('plaid-unreachable')).toHaveTextContent(`${C}.plaid.error`);
    vi.mocked(console.error).mockRestore();
  });

  it('verified EU credentials: "Connect EU bank" opens the bank picker', async () => {
    ebEnabled = true;
    useApi();
    renderOptions();
    fireEvent.click(await screen.findByRole('button', { name: `${C}.enableBanking.connect` }));
    expect(await screen.findByText('enableBanking.connect.title', { selector: 'h2' })).toBeInTheDocument();
  });

  it('caller cannot configure (member/viewer): no setup entry point', async () => {
    configurable = false;
    useApi();
    renderOptions();
    expect(await screen.findByText(`${C}.enableBanking.adminOnly`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `${C}.enableBanking.setup` })).not.toBeInTheDocument();
  });

  it('installed app: the EU option shows the desktop-only note', async () => {
    standalone = true;
    useApi();
    renderOptions();
    expect(within(screen.getByTestId('provider-enable-banking')).getByTestId('desktop-only-bank-note')).toBeInTheDocument();
  });
});

describe('BankProviderOptions — EU setup hand-off and completion (R2, R3)', () => {
  it('a VERIFIED save opens the bank picker with no further click; Continue awaits completion before the redirect', async () => {
    useApi();
    const order: string[] = [];
    const onEnableBankingRedirect = vi.fn(async () => { order.push('recorded'); });
    assign.mockImplementation(() => order.push('assign'));
    renderOptions({ onEnableBankingRedirect });

    fireEvent.click(await screen.findByRole('button', { name: `${C}.enableBanking.setup` }));
    expect(await screen.findByTestId('eb-setup-needs')).toHaveTextContent(`${C}.setup.limit`);
    await fillAndSave();

    // Straight to the picker.
    expect(await screen.findByText('enableBanking.connect.title', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.queryByTestId('eb-setup-needs')).not.toBeInTheDocument();
    // Saving alone records nothing.
    expect(onEnableBankingRedirect).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('option', { name: 'Revolut' }));
    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.connect.continue' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://bank.test/auth'));
    expect(order).toEqual(['recorded', 'assign']);
  });

  it('closing the picker after setup returns to step 2 with "Connect EU bank" and nothing recorded', async () => {
    useApi();
    const { onEnableBankingRedirect, onPlaidComplete } = renderOptions();
    fireEvent.click(await screen.findByRole('button', { name: `${C}.enableBanking.setup` }));
    await fillAndSave();
    await screen.findByText('enableBanking.connect.title', { selector: 'h2' });
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(await screen.findByRole('button', { name: `${C}.enableBanking.connect` })).toBeInTheDocument();
    expect(onEnableBankingRedirect).not.toHaveBeenCalled();
    expect(onPlaidComplete).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    // Plaid stays available.
    expect(screen.getByRole('button', { name: `${C}.plaid.button` })).toBeInTheDocument();
  });

  it('an UNVERIFIED save closes setup instead of opening the picker', async () => {
    useApi({ saveStatus: 'UNVERIFIED' });
    renderOptions();
    fireEvent.click(await screen.findByRole('button', { name: `${C}.enableBanking.setup` }));
    await fillAndSave();
    await waitFor(() => expect(screen.queryByTestId('eb-setup-needs')).not.toBeInTheDocument());
    expect(screen.queryByText('enableBanking.connect.title', { selector: 'h2' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: `${C}.enableBanking.connect` })).toBeInTheDocument();
  });
});
