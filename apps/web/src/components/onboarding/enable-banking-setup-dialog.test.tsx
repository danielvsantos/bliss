/**
 * Enable Banking setup inside onboarding (#154): the Settings form's errors,
 * the "What you need" checklist, and the private key never kept after save.
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
import { EnableBankingSetupDialog } from './enable-banking-setup-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const KEYS_DIR = join(__dirname, '../../../../../packages/shared/test-fixtures/enablebanking-keys');
const PEM = readFileSync(join(KEYS_DIR, 'rsa2048-pkcs8.pem'), 'utf8');
const KEY_BODY_SAMPLE = PEM.split('\n')[1];
const APP_ID = '6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const T = 'enableBanking.credentials';

const EMPTY: EnableBankingCredentialsView = {
  configured: false,
  callbackUrl: 'https://api.example.test/api/enablebanking/callback',
  credential: null,
  usage: { activeConnections: 0, pausedConnections: 0, linkedAccounts: 0, limit: 5 },
  history: [],
};
const VERIFIED: EnableBankingCredentialsView = {
  ...EMPTY,
  configured: true,
  credential: {
    appId: APP_ID,
    keyFingerprint: 'SHA256:abc',
    keyBits: 2048,
    status: 'VERIFIED',
    lastValidatedAt: null,
    callbackRegistered: true,
    updatedAt: '2026-10-18T10:00:00.000Z',
  },
};

function useApi(put: () => Response) {
  server.use(
    http.get('/api/enablebanking/credentials', () => HttpResponse.json(EMPTY)),
    http.put('/api/enablebanking/credentials', () => put()),
    http.get('/api/enablebanking/status', () => HttpResponse.json({ enabled: false, configurable: true, pausedConnections: 0 })),
  );
}

function renderDialog() {
  const onVerified = vi.fn();
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <EnableBankingSetupDialog open onOpenChange={onOpenChange} onVerified={onVerified} />
    </QueryClientProvider>,
  );
  return { onVerified, onOpenChange, queryClient };
}

async function fillAndSave() {
  fireEvent.change(await screen.findByLabelText(`${T}.appIdLabel`), { target: { value: APP_ID } });
  fireEvent.click(screen.getByRole('button', { name: 'enableBanking.keyInput.pasteInstead' }));
  fireEvent.change(screen.getByTestId('eb-key-textarea'), { target: { value: PEM } });
  fireEvent.click(screen.getByRole('button', { name: `${T}.save` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('EnableBankingSetupDialog (#154)', () => {
  it('shows the checklist, the 5-account limit, the guide and the callback URL', async () => {
    useApi(() => HttpResponse.json(VERIFIED));
    renderDialog();
    const needs = screen.getByTestId('eb-setup-needs');
    for (const key of ['needAccount', 'needApp', 'needCallback', 'limit', 'guide']) {
      expect(needs).toHaveTextContent(`onboarding.connect.setup.${key}`);
    }
    expect(screen.getByRole('link', { name: /onboarding\.connect\.setup\.guide/ })).toHaveAttribute('href', expect.stringContaining('enable-banking'));
    expect(await screen.findByTestId('eb-callback-url')).toHaveValue(EMPTY.callbackUrl);
  });

  it.each(['INVALID_CREDENTIALS', 'SANDBOX_APP', 'INVALID_APP_ID'])(
    '%s shows the same error as Settings and does not hand off',
    async (code) => {
      useApi(() => HttpResponse.json({ error: 'x', code }, { status: 400 }));
      const { onVerified } = renderDialog();
      await fillAndSave();
      expect(await screen.findByRole('alert')).toHaveTextContent(`${T}.error${code}`);
      expect(onVerified).not.toHaveBeenCalled();
    },
  );

  it('a KEY_* error is shown on the key input and does not hand off', async () => {
    useApi(() => HttpResponse.json({ error: 'x', code: 'KEY_TOO_SMALL' }, { status: 400 }));
    const { onVerified } = renderDialog();
    await fillAndSave();
    expect(await screen.findByText('enableBanking.keyInput.errorKEY_TOO_SMALL')).toBeInTheDocument();
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('after a verified save the key is not in browser storage or the query/mutation caches', async () => {
    useApi(() => HttpResponse.json(VERIFIED, { status: 201 }));
    const { onVerified, queryClient } = renderDialog();
    await fillAndSave();
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(VERIFIED));

    expect(JSON.stringify({ ...localStorage })).not.toContain(KEY_BODY_SAMPLE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(KEY_BODY_SAMPLE);
    for (const q of queryClient.getQueryCache().getAll()) {
      expect(JSON.stringify(q.state.data ?? null)).not.toContain(KEY_BODY_SAMPLE);
    }
    for (const m of queryClient.getMutationCache().getAll()) {
      expect(JSON.stringify(m.state.variables ?? null)).not.toContain(KEY_BODY_SAMPLE);
    }
  });
});
