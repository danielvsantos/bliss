import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OnboardingAccountSetup } from './onboarding-account-setup';
import { api } from '@/lib/api';

vi.mock('@/lib/api');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o && typeof o.count !== 'undefined' ? `${k}:${o.count}` : o && o.country ? `${k}:${o.country}` : k,
  }),
}));

const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.com', tenantId: 't1' } }),
}));

const ALL_COUNTRIES = [
  { id: 'USA', name: 'United States' },
  { id: 'PRT', name: 'Portugal' },
  { id: 'GBR', name: 'United Kingdom' },
];

// Countries the tenant picked in step 1 — mutated per test to exercise the
// single-country (read-only) vs multi-country (per-account selector) paths.
let tenantCountries: Array<{ id: string; name: string; isDefault?: boolean }> = [
  { id: 'USA', name: 'United States', isDefault: true },
];

vi.mock('@/hooks/use-metadata', () => ({
  useBanks: () => ({
    data: [
      { id: 1, name: 'Chase' },
      { id: 2, name: 'Ally' },
      { id: 3, name: 'Wells Fargo' },
      { id: 4, name: 'Citi' },
      { id: 5, name: 'US Bank' },
      { id: 6, name: 'PNC' },
    ],
  }),
  useMetadata: () => ({
    data: {
      currencies: [
        { id: 'USD', name: 'US Dollar' },
        { id: 'EUR', name: 'Euro' },
      ],
      countries: ALL_COUNTRIES,
    },
  }),
}));

vi.mock('@/utils/tenantMetaStorage', () => ({
  getTenantMeta: () => ({
    id: 't1',
    countries: tenantCountries,
    currencies: [{ id: 'USD', name: 'US Dollar' }],
  }),
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

function renderSetup(props: Partial<React.ComponentProps<typeof OnboardingAccountSetup>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onComplete = props.onComplete ?? vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <OnboardingAccountSetup
        selectedCurrencies={['USD', 'EUR']}
        countryId="USA"
        onComplete={onComplete}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onComplete };
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantCountries = [{ id: 'USA', name: 'United States', isDefault: true }];
  vi.mocked(api.createBank).mockImplementation(async ({ name }) => ({ id: name === 'Chase' ? 1 : 2, name }));
  vi.mocked(api.createAccount).mockResolvedValue({
    id: 10, name: 'X', accountNumber: 'x', bankId: 1, currencyCode: 'USD', countryId: 'USA', owners: [{ userId: 'u1' }],
  });
});

describe('OnboardingAccountSetup', () => {
  it('creates one TenantBank per selected bank and one draft Account per row', async () => {
    const { onComplete } = renderSetup();

    fireEvent.click(screen.getByText('Chase'));
    fireEvent.click(screen.getByText('Ally'));

    // Add a second account row to Chase (first "Add account" button belongs to Chase).
    fireEvent.click(screen.getAllByText('Add account')[0]);

    // Change that new row's currency to EUR.
    const combos = screen.getAllByRole('combobox');
    fireEvent.click(combos[1]); // Chase row 2
    fireEvent.click(await screen.findByRole('option', { name: /Euro/ }));

    fireEvent.click(screen.getByText('Create {{count}} accounts:3'));

    await waitFor(() => expect(api.createBank).toHaveBeenCalledTimes(2));
    expect(api.createBank).toHaveBeenCalledWith({ name: 'Chase' });
    expect(api.createBank).toHaveBeenCalledWith({ name: 'Ally' });

    await waitFor(() => expect(api.createAccount).toHaveBeenCalledTimes(3));
    const payloads = vi.mocked(api.createAccount).mock.calls.map((c) => c[0]);
    expect(payloads.every((p) => p.isDraft === true)).toBe(true);
    expect(payloads.every((p) => p.countryId === 'USA')).toBe(true);
    expect(payloads.every((p) => p.ownerIds.length === 1 && p.ownerIds[0] === 'u1')).toBe(true);

    const chase = payloads.filter((p) => p.bankId === 1);
    expect(chase.map((p) => p.accountNumber).sort()).toEqual(['chase-acc-1', 'chase-acc-2']);
    expect(chase.map((p) => p.currencyCode).sort()).toEqual(['EUR', 'USD']);

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it('with zero banks selected, Continue creates nothing and still completes', async () => {
    const { onComplete } = renderSetup();

    fireEvent.click(screen.getByText('Skip for now'));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(api.createBank).not.toHaveBeenCalled();
    expect(api.createAccount).not.toHaveBeenCalled();
  });

  it('enforces the 5-bank cap', () => {
    renderSetup();
    ['Chase', 'Ally', 'Wells Fargo', 'Citi', 'US Bank'].forEach((name) =>
      fireEvent.click(screen.getByText(name)),
    );
    expect(screen.getByText('PNC').closest('button')).toBeDisabled();
  });

  it('enforces the 3-accounts-per-bank cap', () => {
    renderSetup();
    fireEvent.click(screen.getByText('Chase'));
    // starts with 1 row; add two more → 3 total, then the button is gone
    fireEvent.click(screen.getAllByText('Add account')[0]);
    fireEvent.click(screen.getAllByText('Add account')[0]);
    expect(screen.queryByText('Add account')).not.toBeInTheDocument();
  });

  it('shows a destructive toast and does not complete when creation fails', async () => {
    vi.mocked(api.createBank).mockRejectedValueOnce(new Error('boom'));
    const { onComplete } = renderSetup();

    fireEvent.click(screen.getByText('Chase'));
    fireEvent.click(screen.getByText('Create {{count}} accounts:1'));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })),
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('single-country tenant: no per-account country selector, all accounts get the primary country', async () => {
    // tenantCountries defaults to [USA] in beforeEach
    const { onComplete } = renderSetup({ countryId: 'USA' });

    fireEvent.click(screen.getByText('Chase'));
    // One combobox per row (currency only) — no country Select rendered.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);

    fireEvent.click(screen.getByText('Create {{count}} accounts:1'));

    await waitFor(() => expect(api.createAccount).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createAccount).mock.calls[0][0].countryId).toBe('USA');
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it('multi-country tenant: per-account country selector defaults to primary and is editable', async () => {
    tenantCountries = [
      { id: 'USA', name: 'United States', isDefault: true },
      { id: 'PRT', name: 'Portugal' },
    ];
    const { onComplete } = renderSetup({ countryId: 'USA' });

    fireEvent.click(screen.getByText('Chase'));
    fireEvent.click(screen.getAllByText('Add account')[0]); // Chase gets 2 rows

    // Each row now has 2 comboboxes: [currency, country].
    const combos = screen.getAllByRole('combobox');
    expect(combos).toHaveLength(4);

    // Switch the 2nd row's country (combos[3]) to Portugal; leave row 1 as default.
    fireEvent.click(combos[3]);
    fireEvent.click(await screen.findByRole('option', { name: 'Portugal' }));

    fireEvent.click(screen.getByText('Create {{count}} accounts:2'));

    await waitFor(() => expect(api.createAccount).toHaveBeenCalledTimes(2));
    const countries = vi
      .mocked(api.createAccount)
      .mock.calls.map((c) => c[0].countryId)
      .sort();
    expect(countries).toEqual(['PRT', 'USA']);
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});
