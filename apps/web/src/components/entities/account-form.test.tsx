import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AccountForm } from './account-form';
import { api } from '@/lib/api';
import * as tenantMetaStorage from '@/utils/tenantMetaStorage';
import type { Bank, User } from '@/types/api';

vi.mock('@/lib/api');
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.name ? `${k}:${o.name}` : k) }),
}));

const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.com', tenantId: 't1' } }),
}));

const defaultBanks: Bank[] = [{ id: 1, name: 'Chase' }];

let tenantMetaBanks: Bank[] = defaultBanks;

vi.mock('@/utils/tenantMetaStorage', () => ({
  getTenantMeta: vi.fn(),
  updateTenantMetaFromAPI: vi.fn(),
}));

// jsdom stubs for Radix Select
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

function renderForm(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AccountForm account={null} onClose={onClose} />
    </QueryClientProvider>
  );
}

async function openAddBankDialog(bankName: string) {
  const combos = screen.getAllByRole('combobox');
  fireEvent.click(combos[0]); // Bank select is the first combobox
  fireEvent.click(await screen.findByRole('option', { name: /accountForm\.addBank/ }));
  const input = await screen.findByLabelText('addBankDialog.nameLabel');
  fireEvent.change(input, { target: { value: bankName } });
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantMetaBanks = defaultBanks;
  vi.mocked(tenantMetaStorage.getTenantMeta).mockImplementation(() => ({
    id: 't1',
    name: 'Tenant',
    plan: 'free',
    createdAt: '2026-01-01',
    banks: tenantMetaBanks,
    currencies: [{ id: 'USD', name: 'US Dollar', symbol: '$' }],
    countries: [{ id: 'US', name: 'United States' }],
    transactionYears: [2026],
  }));
  vi.mocked(api.getUsers).mockResolvedValue([{ id: 'u1', email: 'a@b.com' } as User]);
  vi.mocked(api.createBank).mockResolvedValue({ id: 2, name: 'Monzo' });
  vi.mocked(api.createAccount).mockResolvedValue({
    id: 1,
    name: 'Primary',
    accountNumber: '1234',
    bankId: 2,
    currencyCode: 'USD',
    countryId: 'US',
    owners: [{ userId: 'u1' }],
  });
});

describe('AccountForm — inline add bank', () => {
  it('adding a bank from the dropdown selects it and preserves other entered field values', async () => {
    renderForm();

    fireEvent.change(screen.getByPlaceholderText('e.g. Primary Checking, Savings, Credit Card'), {
      target: { value: 'My Checking' },
    });
    fireEvent.change(screen.getByPlaceholderText('Last 4 or full account number'), {
      target: { value: '9999' },
    });

    await openAddBankDialog('Monzo');
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(api.createBank).toHaveBeenCalledWith({ name: 'Monzo' });
    });

    // dialog closed, bank selected
    await waitFor(() => {
      expect(screen.queryByLabelText('addBankDialog.nameLabel')).not.toBeInTheDocument();
    });
    expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('Monzo');

    // other fields untouched
    expect(screen.getByPlaceholderText('e.g. Primary Checking, Savings, Credit Card')).toHaveValue('My Checking');
    expect(screen.getByPlaceholderText('Last 4 or full account number')).toHaveValue('9999');
  });

  it('empty bank list: user can add a bank inline and then submit the account form', async () => {
    tenantMetaBanks = [];
    renderForm();

    fireEvent.change(screen.getByPlaceholderText('e.g. Primary Checking, Savings, Credit Card'), {
      target: { value: 'My Checking' },
    });
    fireEvent.change(screen.getByPlaceholderText('Last 4 or full account number'), {
      target: { value: '9999' },
    });

    await openAddBankDialog('Monzo');
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(api.createBank).toHaveBeenCalledWith({ name: 'Monzo' });
    });
    await waitFor(() => {
      expect(screen.queryByLabelText('addBankDialog.nameLabel')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'accountForm.createAccount' }));

    await waitFor(() => {
      expect(api.createAccount).toHaveBeenCalled();
    });
  });

  it('confirming an existing bank name (idempotent) selects it without calling the API', async () => {
    renderForm();

    await openAddBankDialog(' Chase ');
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('addBankDialog.nameLabel')).not.toBeInTheDocument();
    });
    expect(api.createBank).not.toHaveBeenCalled();
    expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('Chase');
  });

  it('API failure shows a toast and leaves form state intact', async () => {
    vi.mocked(api.createBank).mockRejectedValue(new Error('network fail'));
    renderForm();

    const input = await openAddBankDialog('Revolut');
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive', description: 'accountForm.addBankError' })
      );
    });

    // dialog stays open with the typed name intact
    expect(input).toHaveValue('Revolut');
    // bank selection unchanged (no bank was selected before); query bypassing
    // aria-hidden since the open dialog hides the rest of the form from the a11y tree
    expect(screen.getAllByRole('combobox', { hidden: true })[0]).not.toHaveTextContent('Revolut');
    expect(api.createAccount).not.toHaveBeenCalled();
  });

  it('pressing Enter in the mini-dialog does not submit the account form', async () => {
    renderForm();

    const input = await openAddBankDialog('Monzo');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(api.createBank).toHaveBeenCalledWith({ name: 'Monzo' });
    });
    expect(api.createAccount).not.toHaveBeenCalled();
  });
});
