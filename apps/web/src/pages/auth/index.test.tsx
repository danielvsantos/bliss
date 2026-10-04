import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AuthPage from './index';
import * as AuthHook from '@/hooks/use-auth';
import * as TenantMeta from '@/utils/tenantMetaStorage';
import { useSignupMode } from '@/hooks/use-signup-mode';
import en from '@/i18n/locales/en';
import es from '@/i18n/locales/es';
import fr from '@/i18n/locales/fr';
import pt from '@/i18n/locales/pt';
import it_ from '@/i18n/locales/it';

// Mock translations
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Mock tenant meta
vi.mock('@/utils/tenantMetaStorage', () => ({
  setTenantMeta: vi.fn()
}));

// Setup auth context mocks
const mockSignIn = vi.fn();
const mockSignUp = vi.fn();
const mockSignInWithGoogle = vi.fn();

vi.mock('@/hooks/use-auth', () => ({
  useAuth: vi.fn()
}));

// Invite-only flag (#99): open mode unless a test says otherwise.
vi.mock('@/hooks/use-signup-mode', () => ({
  useSignupMode: vi.fn(() => ({ inviteOnly: false })),
}));

// Mock window.matchMedia for jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe('AuthPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AuthHook.useAuth).mockReturnValue({
      signIn: mockSignIn,
      signUp: mockSignUp,
      signInWithGoogle: mockSignInWithGoogle,
      googleOAuthEnabled: true,
    } as unknown as ReturnType<typeof AuthHook.useAuth>);
    vi.mocked(useSignupMode).mockReturnValue({ inviteOnly: false });
  });

  const renderAuthPage = () => {
    return render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>
    );
  };

  it('renders sign in form by default', () => {
    renderAuthPage();
    // 2 occurrences of "Sign In" initially (the tab and the submit button)
    expect(screen.getAllByText('Sign In').length).toBeGreaterThan(0);
    expect(screen.getByText('Sign in with Google')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
  });

  it('switches to sign up form when tab is clicked', () => {
    renderAuthPage();
    
    // Switch to sign up
    fireEvent.click(screen.getByRole('button', { name: "Sign Up" }));
    
    expect(screen.getByText('Sign up with Google')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Alex Morgan')).toBeInTheDocument(); // Name field
    expect(screen.getByText('Create Account')).toBeInTheDocument();
  });

  it('calls signIn logic successfully', async () => {
    mockSignIn.mockResolvedValueOnce({});
    renderAuthPage();

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@bliss.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    
    // Find the submit button specifically since there are 2 "Sign In" buttons (tab vs submit)
    const submitBtn = screen.getAllByRole('button', { name: 'Sign In' }).find(b => b.getAttribute('type') === 'submit');
    fireEvent.click(submitBtn!);

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith({ email: 'test@bliss.com', password: 'password123' });
    });
  });

  it('calls signUp logic and sets tenant metadata successfully', async () => {
    mockSignUp.mockResolvedValueOnce({
      user: { tenant: { id: 't1', name: 'Test Tenant', plan: 'PRO' } }
    });
    
    renderAuthPage();
    fireEvent.click(screen.getByRole('button', { name: "Sign Up" })); // switch tab

    fireEvent.change(screen.getByPlaceholderText('Alex Morgan'), { target: { value: 'Alex Morgan' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alex@bliss.com' } });
    fireEvent.change(screen.getByPlaceholderText('8+ characters'), { target: { value: 'securePass1' } });
    
    const submitBtn = screen.getByRole('button', { name: 'Create Account' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith(expect.objectContaining({
        email: 'alex@bliss.com',
        password: 'securePass1',
        name: 'Alex Morgan'
      }));
    });

    expect(TenantMeta.setTenantMeta).toHaveBeenCalledWith(expect.objectContaining({
      id: 't1',
      name: 'Test Tenant'
    }));
  });

  it('returns to a safe returnTo after sign-in (OAuth consent, #89)', async () => {
    mockSignIn.mockResolvedValueOnce({});
    window.history.pushState({}, '', '/auth?returnTo=%2Foauth%2Fconsent%3Frequest%3Dabc');
    render(
      <MemoryRouter initialEntries={['/auth']}>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/oauth/consent" element={<div data-testid="consent-page" />} />
          <Route path="/" element={<div data-testid="home-page" />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'test@bliss.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign In' }).find((b) => b.getAttribute('type') === 'submit')!);
    expect(await screen.findByTestId('consent-page')).toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('handles sign in failures gracefully', async () => {
    mockSignIn.mockRejectedValueOnce(new Error('Invalid credentials'));
    renderAuthPage();

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'wrong@bliss.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'badpass' } });
    
    const submitBtn = screen.getAllByRole('button', { name: 'Sign In' }).find(b => b.getAttribute('type') === 'submit');
    fireEvent.click(submitBtn!);

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });
  // The API redirects here with ?error=<code> when a Google sign-in is
  // rejected. Before this, the param was written by the callback page but
  // never read, so every OAuth rejection arrived as silence — including "an
  // account with this email already exists, use your password", which is only
  // actionable if the user is actually told.
  describe('OAuth rejection banner (?error=)', () => {
    const setSearch = (search: string) => {
      window.history.replaceState({}, '', `/auth${search}`);
    };

    beforeEach(() => {
      setSearch('');
    });

    it('renders nothing when there is no error param', () => {
      renderAuthPage();
      expect(screen.queryByTestId('oauth-error')).not.toBeInTheDocument();
    });

    it.each([
      [
        'google_account_exists',
        'An account with this email already exists. Sign in with your password instead.',
      ],
      [
        'google_email_unverified',
        "Your Google account's email address is not verified. Verify it with Google, then try again.",
      ],
      ['oauth_failed', 'Sign-in with Google failed. Please try again.'],
    ])('maps ?error=%s to its own message', (code, expected) => {
      setSearch(`?error=${code}`);
      renderAuthPage();

      expect(screen.getByTestId('oauth-error')).toHaveTextContent(expected);
    });

    it('falls back to the generic message for an unrecognised code', () => {
      setSearch('?error=something_unexpected');
      renderAuthPage();

      expect(screen.getByTestId('oauth-error')).toHaveTextContent(
        'Sign-in with Google failed. Please try again.',
      );
    });

    // AuthCard is mounted from two layouts and useIsDesktop resolves after the
    // first paint, so the initial card unmounts and a fresh one takes its
    // place. The message must survive that swap — an effect that consumed the
    // param would clear it on the first card and leave the second with
    // nothing, hiding the message on exactly the render the user sees.
    it('keeps showing the message after the layout swap remounts the card', async () => {
      setSearch('?error=google_account_exists');
      renderAuthPage();

      await waitFor(() => {
        expect(screen.getByTestId('oauth-error')).toBeInTheDocument();
      });
      expect(screen.getByTestId('oauth-error')).toHaveTextContent(
        'An account with this email already exists. Sign in with your password instead.',
      );
    });
  });
  // Invite-only sign-up (#99).
  describe('invite-only sign-up', () => {
    const NOTICE = 'This Bliss instance is invite-only. Use the email address you were invited with.';
    const REJECTED =
      "This email hasn't been invited to this Bliss instance. Ask the person who runs it for an invite.";

    beforeEach(() => {
      window.history.replaceState({}, '', '/auth');
    });

    const openSignUp = () => {
      renderAuthPage();
      fireEvent.click(screen.getByRole('button', { name: 'Sign Up' }));
    };

    it('shows the notice on the Sign Up tab when the instance is invite-only', () => {
      vi.mocked(useSignupMode).mockReturnValue({ inviteOnly: true });
      openSignUp();
      expect(screen.getByTestId('invite-only-notice')).toHaveTextContent(NOTICE);
      // No invite-code field: the form is unchanged.
      expect(screen.queryByPlaceholderText(/code/i)).not.toBeInTheDocument();
    });

    it('does not show the notice in open mode', () => {
      openSignUp();
      expect(screen.queryByTestId('invite-only-notice')).not.toBeInTheDocument();
    });

    it('does not show the notice on the Sign In tab', () => {
      vi.mocked(useSignupMode).mockReturnValue({ inviteOnly: true });
      renderAuthPage();
      expect(screen.queryByTestId('invite-only-notice')).not.toBeInTheDocument();
    });

    it('shows the localized rejection for a SIGNUP_INVITE_REQUIRED sign-up error', async () => {
      mockSignUp.mockRejectedValueOnce(
        Object.assign(new Error('Sign-up on this instance is by invitation only.'), {
          code: 'SIGNUP_INVITE_REQUIRED',
        }),
      );
      openSignUp();
      fireEvent.change(screen.getByPlaceholderText('Alex Morgan'), { target: { value: 'Alex Morgan' } });
      fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alex@bliss.com' } });
      fireEvent.change(screen.getByPlaceholderText('8+ characters'), { target: { value: 'securePass1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

      expect(await screen.findByText(REJECTED)).toBeInTheDocument();
      expect(screen.queryByText('Sign-up on this instance is by invitation only.')).not.toBeInTheDocument();
    });

    it('maps ?error=signup_invite_required from the Google redirect', () => {
      window.history.replaceState({}, '', '/auth?error=signup_invite_required');
      renderAuthPage();
      expect(screen.getByTestId('oauth-error')).toHaveTextContent(REJECTED);
      window.history.replaceState({}, '', '/auth');
    });

    it.each([
      ['en', en],
      ['es', es],
      ['fr', fr],
      ['pt', pt],
      ['it', it_],
    ])('has both strings in the %s locale', (_loc, dict) => {
      const d = dict as unknown as Record<string, unknown>;
      expect(typeof d[NOTICE]).toBe('string');
      expect(typeof d[REJECTED]).toBe('string');
    });
  });
});
