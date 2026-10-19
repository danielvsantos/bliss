/**
 * Settings → Bank sync (#148): set up, verify states, confirmations for an
 * app change and a removal, the paused banner and the change history. The
 * private key never outlives the save request in the page.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import type { EnableBankingCredentialsView } from '@/types/api';
import { BankSyncTab } from './bank-sync-tab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));
const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));

const KEYS_DIR = join(__dirname, '../../../../../packages/shared/test-fixtures/enablebanking-keys');
const PEM = readFileSync(join(KEYS_DIR, 'rsa2048-pkcs8.pem'), 'utf8');
const APP_ID = '6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const T = 'enableBanking.credentials';

const EMPTY: EnableBankingCredentialsView = {
  configured: false,
  callbackUrl: 'https://api.example.test/api/enablebanking/callback',
  credential: null,
  usage: { activeConnections: 0, pausedConnections: 0, linkedAccounts: 0, limit: 5 },
  history: [],
};
const CONFIGURED: EnableBankingCredentialsView = {
  ...EMPTY,
  configured: true,
  credential: {
    appId: APP_ID,
    keyFingerprint: 'SHA256:Ykx6kBhllCCFAvf5',
    keyBits: 2048,
    status: 'VERIFIED',
    lastValidatedAt: '2026-10-18T10:00:00.000Z',
    callbackRegistered: true,
    updatedAt: '2026-10-18T10:00:00.000Z',
  },
  usage: { activeConnections: 2, pausedConnections: 0, linkedAccounts: 3, limit: 5 },
  history: [
    { action: 'SET', appId: APP_ID, keyFingerprint: 'SHA256:Ykx6kBhllCCFAvf5', user: { id: 'u1', name: 'Daniel' }, createdAt: '2026-10-18T10:00:00.000Z' },
  ],
};

let current: EnableBankingCredentialsView;
const requests: Array<{ method: string; url: string; body: unknown }> = [];

function useApi({ put, del }: { put?: (body: Record<string, unknown>) => Response; del?: (url: URL) => Response } = {}) {
  server.use(
    http.get('/api/enablebanking/credentials', () => HttpResponse.json(current)),
    http.put('/api/enablebanking/credentials', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ method: 'PUT', url: request.url, body });
      if (put) return put(body);
      current = CONFIGURED;
      return HttpResponse.json(current, { status: 201 });
    }),
    http.delete('/api/enablebanking/credentials', ({ request }) => {
      const url = new URL(request.url);
      requests.push({ method: 'DELETE', url: request.url, body: null });
      if (del) return del(url);
      current = { ...EMPTY, usage: { ...EMPTY.usage, pausedConnections: 2 } };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/enablebanking/credentials/verify', () => HttpResponse.json(current)),
  );
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BankSyncTab />
    </QueryClientProvider>,
  );
  return queryClient;
}

async function fillForm() {
  fireEvent.change(await screen.findByLabelText(`${T}.appIdLabel`), { target: { value: APP_ID } });
  fireEvent.click(screen.getByRole('button', { name: 'enableBanking.keyInput.pasteInstead' }));
  fireEvent.change(screen.getByTestId('eb-key-textarea'), { target: { value: PEM } });
}

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  current = EMPTY;
});

describe('BankSyncTab — not configured', () => {
  it('shows the callback URL and keeps Save disabled until both fields are valid', async () => {
    useApi();
    renderTab();
    expect(await screen.findByTestId('eb-callback-url')).toHaveValue(EMPTY.callbackUrl);
    const save = screen.getByRole('button', { name: `${T}.save` });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`${T}.appIdLabel`), { target: { value: 'not-a-uuid' } });
    expect(screen.getByText(`${T}.appIdInvalid`)).toBeInTheDocument();
    await fillForm();
    expect(save).toBeEnabled();
  });

  it('saves, then shows Verified with the fingerprint and history; the key is gone from the page', async () => {
    useApi();
    const queryClient = renderTab();
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: `${T}.save` }));

    expect(await screen.findByTestId('eb-credential-status')).toHaveTextContent(`${T}.statusVERIFIED`);
    expect(screen.getByTestId('eb-credential-status').className).toContain('text-positive');
    expect(screen.getByTestId('eb-key-fingerprint')).toHaveTextContent('SHA256:Ykx6kBhllCCFAvf5');
    expect(screen.getByTestId('eb-credential-history')).toHaveTextContent(`${T}.historySET`);
    expect(requests).toEqual([expect.objectContaining({ method: 'PUT', body: { appId: APP_ID, privateKey: PEM } })]);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: `${T}.savedTitle`, description: `${T}.savedDesc` }));

    expect(screen.queryByTestId('eb-key-textarea')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('PRIVATE KEY');
    const cached = JSON.stringify([
      queryClient.getQueryCache().getAll().map((q) => q.state.data),
      queryClient.getMutationCache().getAll().map((m) => m.state.variables),
    ]);
    expect(cached).not.toContain('PRIVATE KEY');
  });

  it('shows the paused banner when connections wait for credentials', async () => {
    current = { ...EMPTY, usage: { ...EMPTY.usage, pausedConnections: 3 } };
    useApi();
    renderTab();
    expect(await screen.findByTestId('eb-paused-banner')).toHaveTextContent(`${T}.pausedBanner {"count":3}`);
  });

  it('shows the specific message when Enable Banking rejects the credentials', async () => {
    useApi({ put: () => HttpResponse.json({ code: 'INVALID_CREDENTIALS' }, { status: 422 }) });
    renderTab();
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: `${T}.save` }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`${T}.errorINVALID_CREDENTIALS`);
    expect(screen.getByTestId('eb-key-textarea')).toHaveValue(PEM); // kept for a retry
  });

  it('shows a server-side key format error under the key input', async () => {
    useApi({ put: () => HttpResponse.json({ code: 'KEY_TRUNCATED' }, { status: 400 }) });
    renderTab();
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: `${T}.save` }));
    await waitFor(() => expect(screen.getByTestId('eb-key-result')).toHaveTextContent('enableBanking.keyInput.errorKEY_TRUNCATED'));
  });
});

describe('BankSyncTab — configured', () => {
  it('replacing with another app asks for confirmation with the affected count, then resends confirmed', async () => {
    current = CONFIGURED;
    useApi({
      put: (body) => (body.confirmAppChange
        ? HttpResponse.json(CONFIGURED)
        : HttpResponse.json({ code: 'CONFIRMATION_REQUIRED', affectedConnections: 2 }, { status: 409 })),
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: `${T}.replace` }));
    expect(screen.getByLabelText(`${T}.appIdLabel`)).toHaveValue(APP_ID); // kept: rotate the key only
    fireEvent.change(screen.getByLabelText(`${T}.appIdLabel`), { target: { value: '99999999-8888-4777-8666-555555555555' } });
    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.keyInput.pasteInstead' }));
    fireEvent.change(screen.getByTestId('eb-key-textarea'), { target: { value: PEM } });
    fireEvent.click(screen.getByRole('button', { name: `${T}.save` }));

    expect(await screen.findByText(`${T}.confirmAppChangeDesc {"count":2}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `${T}.confirmContinue` }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].body).toMatchObject({ confirmAppChange: true });
    expect(await screen.findByTestId('eb-key-fingerprint')).toBeInTheDocument();
  });

  it('removing with connections asks first, then sends confirm=true', async () => {
    current = CONFIGURED;
    useApi({
      del: (url) => {
        if (url.searchParams.get('confirm') !== 'true') {
          return HttpResponse.json({ code: 'CONFIRMATION_REQUIRED', affectedConnections: 2 }, { status: 409 });
        }
        current = { ...EMPTY, usage: { ...EMPTY.usage, pausedConnections: 2 } };
        return new HttpResponse(null, { status: 204 });
      },
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: `${T}.remove` }));
    expect(await screen.findByText(`${T}.confirmRemoveDesc {"count":2}`)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: `${T}.remove` }).at(-1)!);
    await waitFor(() => expect(requests.map((r) => new URL(r.url).searchParams.get('confirm'))).toEqual([null, 'true']));
    expect(await screen.findByTestId('eb-paused-banner')).toBeInTheDocument();
  });

  it.each([
    ['INVALID', 'text-destructive', `${T}.invalidDesc`],
    ['UNVERIFIED', 'text-warning', `${T}.unverifiedDesc`],
  ] as const)('shows %s with its token colour and explanation', async (status, cls, desc) => {
    current = { ...CONFIGURED, credential: { ...CONFIGURED.credential!, status } };
    useApi();
    renderTab();
    expect((await screen.findByTestId('eb-credential-status')).className).toContain(cls);
    expect(screen.getByText(desc)).toBeInTheDocument();
  });

  it('warns when the callback URL is not registered on the app', async () => {
    current = { ...CONFIGURED, credential: { ...CONFIGURED.credential!, callbackRegistered: false } };
    useApi();
    renderTab();
    expect(await screen.findByTestId('eb-callback-missing')).toBeInTheDocument();
  });

  it('re-verify reports the outcome', async () => {
    current = CONFIGURED;
    useApi();
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: `${T}.reverify` }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: `${T}.verifiedTitle` })));
  });
});
