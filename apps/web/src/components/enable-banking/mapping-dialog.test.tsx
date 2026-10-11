import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import type { EnableBankingConnectionResponse, EnableBankingMapRequest } from '@/types/api';
import { EnableBankingMappingDialog } from './mapping-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/utils/tenantMetaStorage', () => ({
  getTenantMeta: () => ({
    banks: [{ id: 7, name: 'Banco Uno' }],
    countries: [{ id: 'ES', name: 'Spain', isDefault: true }],
    currencies: [{ id: 'EUR', name: 'Euro', isDefault: true }],
  }),
}));

const CONNECTION: EnableBankingConnectionResponse = {
  connection: {
    id: 'item-1',
    institutionName: 'Banco Uno',
    aspspCountry: 'ES',
    status: 'PENDING_SELECTION',
    consentExpiration: '2027-04-01T00:00:00.000Z',
    lastSync: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    authorizedByMe: true,
  },
  startDate: '2026-04-15',
  accounts: [
    {
      id: 'eb-1', name: 'Cuenta Nómina', ibanLast4: '0123', currency: 'EUR', accountId: null,
      suggestedAccountId: 10, conflict: false, lastBalance: '1234.50', lastBalanceCurrency: 'EUR', lastBalanceAt: '2026-10-10T08:00:00.000Z',
    },
    {
      id: 'eb-2', name: 'Cuenta Conjunta', ibanLast4: '9999', currency: 'EUR', accountId: null,
      suggestedAccountId: null, conflict: true, lastBalance: null, lastBalanceCurrency: null, lastBalanceAt: null,
    },
    {
      id: 'eb-3', name: 'Ahorro', ibanLast4: '4444', currency: 'EUR', accountId: null,
      suggestedAccountId: null, conflict: false, lastBalance: null, lastBalanceCurrency: null, lastBalanceAt: null,
    },
  ],
  blissAccounts: [
    { id: 10, name: 'Checking', currencyCode: 'EUR', last4: '0123', linkedProvider: 'PLAID', linkedToThisConnection: false },
    { id: 11, name: 'Savings', currencyCode: 'EUR', last4: null, linkedProvider: null, linkedToThisConnection: false },
  ],
};

let mapBodies: EnableBankingMapRequest[] = [];

function useHandlers({ switchRequired = true } = {}) {
  server.use(
    http.get('/api/enablebanking/connections/item-1', () => HttpResponse.json(CONNECTION)),
    http.post('/api/enablebanking/connections/item-1/map', async ({ request }) => {
      const body = (await request.json()) as EnableBankingMapRequest;
      mapBodies.push(body);
      if (switchRequired && !body.confirmProviderSwitch) {
        return HttpResponse.json(
          {
            code: 'PROVIDER_SWITCH_REQUIRED',
            error: 'confirm',
            accounts: [{ id: 10, name: 'Checking', provider: 'PLAID', institutionName: 'Chase' }],
          },
          { status: 409 },
        );
      }
      return HttpResponse.json({ mapped: 1, created: 0, skipped: 1, switched: 1, active: true });
    }),
  );
}

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <EnableBankingMappingDialog connectionId="item-1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  mapBodies = [];
});

describe('EnableBankingMappingDialog (#132)', () => {
  it('pre-selects suggestions, never defaults to "create", and shows the start date', async () => {
    useHandlers();
    renderDialog();

    const row1 = await screen.findByTestId('eb-map-row-eb-1');
    expect(row1).toHaveAttribute('data-choice', 'acc:10');
    // IBAN last 4 keeps its leading zero (no numeric coercion of the response).
    expect(row1).toHaveTextContent('•••• 0123');
    // The suggested target is synced by Plaid → switch hint.
    expect(within(row1).getByText('enableBanking.mapping.switchHint')).toBeInTheDocument();

    // No suggestion → "Don't sync", not "Create new account".
    expect(screen.getByTestId('eb-map-row-eb-3')).toHaveAttribute('data-choice', 'skip');

    const notice = screen.getByTestId('eb-start-date');
    expect(notice).toHaveTextContent('enableBanking.connect.startDate');
    expect(notice).toHaveTextContent(/Apr.*2026|2026.*Apr/);
  });

  it('disables rows already synced through another person\'s connection, with an explanation', async () => {
    useHandlers();
    renderDialog();

    const row2 = await screen.findByTestId('eb-map-row-eb-2');
    expect(within(row2).getByRole('combobox')).toBeDisabled();
    expect(within(row2).getByText('enableBanking.mapping.conflict')).toBeInTheDocument();
    // The other rows stay editable.
    expect(within(screen.getByTestId('eb-map-row-eb-1')).getByRole('combobox')).toBeEnabled();
  });

  it('asks to confirm a provider switch on 409, then resubmits with confirmProviderSwitch', async () => {
    useHandlers();
    const onClose = renderDialog();

    await screen.findByTestId('eb-map-row-eb-1');
    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.mapping.submit' }));

    // Confirmation step lists the account that stops syncing from Plaid.
    expect(await screen.findByText('enableBanking.mapping.switchTitle')).toBeInTheDocument();
    const list = screen.getByTestId('eb-switch-list');
    expect(list).toHaveTextContent('Checking');
    expect(list).toHaveTextContent('enableBanking.mapping.providerPlaid');
    expect(screen.getByText('enableBanking.mapping.switchDesc')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    expect(mapBodies[0]).toEqual({
      mappings: [
        { ebAccountId: 'eb-1', accountId: 10 },
        { ebAccountId: 'eb-3', skip: true },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.mapping.switchConfirm' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mapBodies).toHaveLength(2);
    expect(mapBodies[1]).toEqual({
      mappings: [
        { ebAccountId: 'eb-1', accountId: 10 },
        { ebAccountId: 'eb-3', skip: true },
      ],
      confirmProviderSwitch: true,
    });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'enableBanking.mapping.successTitle' }));
  });

  it('submits directly and closes when no switch is needed', async () => {
    useHandlers({ switchRequired: false });
    const onClose = renderDialog();

    await screen.findByTestId('eb-map-row-eb-1');
    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.mapping.submit' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mapBodies).toHaveLength(1);
    expect(screen.queryByText('enableBanking.mapping.switchTitle')).not.toBeInTheDocument();
  });

  it('shows an error for ACCOUNT_ALREADY_CONNECTED and stays open', async () => {
    server.use(
      http.get('/api/enablebanking/connections/item-1', () => HttpResponse.json(CONNECTION)),
      http.post('/api/enablebanking/connections/item-1/map', () =>
        HttpResponse.json({ code: 'ACCOUNT_ALREADY_CONNECTED', error: 'x' }, { status: 409 }),
      ),
    );
    const onClose = renderDialog();

    await screen.findByTestId('eb-map-row-eb-1');
    fireEvent.click(screen.getByRole('button', { name: 'enableBanking.mapping.submit' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'enableBanking.mapping.errorAlreadyConnected', variant: 'destructive' }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
