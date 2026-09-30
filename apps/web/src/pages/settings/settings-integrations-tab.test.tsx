/**
 * Settings → Integrations tab visibility (#84, AC8): admin only.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import SettingsPage from './index';
import { useAuth } from '@/hooks/use-auth';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';
import { useMetadata } from '@/hooks/use-metadata';
import { useTenantSettings, useUpdateTenantSettings } from '@/hooks/use-tenant-settings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));
vi.mock('@/hooks/use-auth');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-tenant-settings');
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/utils/tenantMetaStorage', () => ({
  getTenantMeta: () => ({ name: 'T', plan: 'FREE', countries: [], currencies: [], banks: [] }),
  setTenantMeta: vi.fn(),
  updateTenantMetaFromAPI: vi.fn().mockResolvedValue(null),
  pickTenantMetaFields: vi.fn(),
}));
vi.mock('@/components/settings/maintenance-tab', () => ({ MaintenanceTab: () => <div>maintenance</div> }));
vi.mock('@/components/settings/integrations-tab', () => ({ IntegrationsTab: () => <div>integrations</div> }));

function renderAs(role: 'admin' | 'member' | 'viewer') {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 'u1', email: 'u@test', role, tenant: { id: 't1', name: 'T' } },
    signOut: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useMetadata).mockReturnValue(
    mockQueryResult({ countries: [], currencies: [], banks: [] }) as unknown as ReturnType<typeof useMetadata>,
  );
  vi.mocked(useTenantSettings).mockReturnValue(
    mockQueryResult({ autoPromoteThreshold: 0.9, reviewThreshold: 0.7, portfolioCurrency: 'USD', plaidHistoryDays: 1 }),
  );
  vi.mocked(useUpdateTenantSettings).mockReturnValue(
    mockMutationResult() as unknown as ReturnType<typeof useUpdateTenantSettings>,
  );
});

describe('Settings page — Integrations tab', () => {
  it('is shown to admins', () => {
    renderAs('admin');
    expect(screen.getByRole('tab', { name: /pages\.settings\.tabs\.integrations/ })).toBeInTheDocument();
  });

  it.each(['member', 'viewer'] as const)('is hidden from %s users', (role) => {
    renderAs(role);
    // The page itself rendered (not a loading skeleton).
    expect(screen.getByRole('tab', { name: /pages\.settings\.tabs\.general/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /pages\.settings\.tabs\.integrations/ })).not.toBeInTheDocument();
    expect(screen.queryByText('integrations')).not.toBeInTheDocument();
  });
});
