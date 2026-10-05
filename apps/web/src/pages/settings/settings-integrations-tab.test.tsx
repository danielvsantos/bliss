/**
 * Settings tab navigation: Integrations tab visibility (#84, AC8: admin only)
 * and the responsive side-nav / pill-row layout.
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
import { useIsMobile } from '@/hooks/use-mobile';
import { useTenantSettings, useUpdateTenantSettings } from '@/hooks/use-tenant-settings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));
vi.mock('@/hooks/use-auth');
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: vi.fn(() => false) }));
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
vi.mock('@/components/settings/processing-tab', () => ({ ProcessingTab: () => <div>processing-tab-content</div> }));

function renderAs(role: 'admin' | 'member' | 'viewer', path = '/settings') {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 'u1', email: 'u@test', role, tenant: { id: 't1', name: 'T' } },
    signOut: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useIsMobile).mockReturnValue(false);
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

  it('groups the admin-only tabs under an Administration heading', () => {
    renderAs('admin');
    expect(screen.getByText('pages.settings.tabs.admin_section')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /pages\.settings\.tabs\.maintenance/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /pages\.settings\.tabs\.ai_classification/ })).toBeInTheDocument();
  });

  it('hides the Administration heading and admin tabs from members', () => {
    renderAs('member');
    expect(screen.queryByText('pages.settings.tabs.admin_section')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /pages\.settings\.tabs\.maintenance/ })).not.toBeInTheDocument();
  });

  it('shows every tab label (no icon-only tabs) in a vertical tablist on desktop', () => {
    renderAs('admin');
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getAllByRole('tab')).toHaveLength(7);
  });

  it('switches to a horizontal (scrollable) tablist on mobile', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    renderAs('admin');
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'horizontal');
  });
});

describe('Settings page — Processing tab (#100)', () => {
  it('is an admin tab next to Maintenance (AC12)', () => {
    renderAs('admin');
    expect(screen.getByRole('tab', { name: /pages\.settings\.tabs\.processing/ })).toBeInTheDocument();
  });

  it.each(['member', 'viewer'] as const)('is hidden from %s users (AC7)', (role) => {
    renderAs(role, '/settings?tab=processing');
    expect(screen.queryByRole('tab', { name: /pages\.settings\.tabs\.processing/ })).not.toBeInTheDocument();
    expect(screen.queryByText('processing-tab-content')).not.toBeInTheDocument();
    // An admin-only deep link falls back to General.
    expect(screen.getByRole('tab', { name: /pages\.settings\.tabs\.general/ })).toHaveAttribute('data-state', 'active');
  });

  it('opens straight to Processing from ?tab=processing (notification / "See progress" link)', () => {
    renderAs('admin', '/settings?tab=processing');
    expect(screen.getByRole('tab', { name: /pages\.settings\.tabs\.processing/ })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('processing-tab-content')).toBeInTheDocument();
  });
});
