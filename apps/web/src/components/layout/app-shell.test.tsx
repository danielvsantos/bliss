import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./Sidebar', () => ({ Sidebar: () => <nav /> }));
vi.mock('./Header', () => ({ Header: () => <header /> }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { role: 'admin' } }) }));
vi.mock('@/hooks/use-onboarding-progress', () => ({
  useCompleteOnboardingStep: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/use-plaid-review', () => ({ usePlaidTransactions: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-imports', () => ({ usePendingImports: () => ({ data: undefined }) }));

import { AppShell } from './app-shell';

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
}

function renderShell() {
  return render(
    <MemoryRouter>
      <AppShell>
        <p>Net worth € 123,456</p>
      </AppShell>
    </MemoryRouter>,
  );
}

describe('AppShell offline gate (#155, PRD R4/AC3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the page while online', () => {
    setOnline(true);
    renderShell();
    expect(screen.getByText('Net worth € 123,456')).toBeInTheDocument();
    expect(screen.queryByTestId('offline-screen')).not.toBeInTheDocument();
  });

  it('shows the offline screen and no figures while offline, and recovers', () => {
    setOnline(false);
    renderShell();
    expect(screen.getByTestId('offline-screen')).toBeInTheDocument();
    expect(screen.getByText('pwa.offline.title')).toBeInTheDocument();
    expect(screen.queryByText(/123,456/)).not.toBeInTheDocument();

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByText('Net worth € 123,456')).toBeInTheDocument();
  });
});
