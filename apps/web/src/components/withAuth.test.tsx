import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { withAuth } from './withAuth';

vi.mock('@/hooks/use-auth');
import { useAuth } from '@/hooks/use-auth';

const MockPage = () => <div data-testid="protected-page">Protected Content</div>;
const ProtectedPage = withAuth(MockPage);

const renderWithRouter = (ui: React.ReactElement) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

describe('withAuth', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows a loading spinner when loading=true', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null, loading: true, signOut: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    renderWithRouter(<ProtectedPage />);
    // Loading spinner div is present; protected page is not
    expect(screen.queryByTestId('protected-page')).not.toBeInTheDocument();
  });

  it('renders the wrapped component when user is authenticated', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: 1, email: 'test@example.com' },
      loading: false,
      signOut: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    renderWithRouter(<ProtectedPage />);
    expect(screen.getByTestId('protected-page')).toBeInTheDocument();
  });

  it('renders nothing (null) when user is null and not loading', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null, loading: false, signOut: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    renderWithRouter(<ProtectedPage />);
    expect(screen.queryByTestId('protected-page')).not.toBeInTheDocument();
  });

  it('redirects to sign-in with a returnTo for the current page', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null, loading: false, signOut: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    function AuthProbe() {
      const location = useLocation();
      return <div data-testid="auth-page">{`${location.pathname}${location.search}`}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/oauth/consent?request=abc']}>
        <Routes>
          <Route path="/oauth/consent" element={<ProtectedPage />} />
          <Route path="/auth" element={<AuthProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('auth-page').textContent).toBe('/auth?returnTo=%2Foauth%2Fconsent%3Frequest%3Dabc');
  });
});
