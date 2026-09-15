import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/api';
import React from 'react';
import type { User } from '@/types/api';
import { AuthProvider } from './AuthContext';
import { useAuth } from '@/hooks/use-auth';

vi.mock('@/lib/api', () => ({
  default: {
    getSession: vi.fn(),
    signin: vi.fn(),
    signout: vi.fn(),
    signup: vi.fn(),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/utils/tenantMetaStorage', () => ({
  updateTenantMetaFromAPI: vi.fn().mockResolvedValue(undefined),
}));

const createWrapper = () => {
  return {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    ),
  };
};

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when used outside AuthProvider', () => {
    // Suppress console.error for the expected error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within an AuthProvider');

    consoleSpy.mockRestore();
  });

  it('checks session on mount', async () => {
    const mockUser: User = { id: '1', email: 'test@example.com', name: 'Test' };
    vi.mocked(api.getSession).mockResolvedValueOnce({ user: mockUser });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAuth(), { wrapper });

    // Initially loading
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(api.getSession).toHaveBeenCalledOnce();
    expect(result.current.user).toEqual(mockUser);
  });

  it('signIn calls api.signin and refreshes session', async () => {
    // First call is mount checkSession, second is post-signin checkSession
    const mockUser: User = { id: '1', email: 'test@example.com', name: 'Test' };
    vi.mocked(api.getSession)
      .mockResolvedValueOnce(null)   // mount: no session yet
      .mockResolvedValueOnce({ user: mockUser }); // after signin
    vi.mocked(api.signin).mockResolvedValueOnce({ user: mockUser });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAuth(), { wrapper });

    // Wait for initial mount check to complete
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();

    // Sign in
    await act(async () => {
      await result.current.signIn({ email: 'test@example.com', password: 'password123' });
    });

    expect(api.signin).toHaveBeenCalledWith({ email: 'test@example.com', password: 'password123' });
    await waitFor(() => expect(result.current.user).toEqual(mockUser));
  });

  it('signOut clears user state', async () => {
    const mockUser: User = { id: '1', email: 'test@example.com', name: 'Test' };
    vi.mocked(api.getSession).mockResolvedValueOnce({ user: mockUser });
    vi.mocked(api.signout).mockResolvedValueOnce(undefined);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.user).toEqual(mockUser));

    await act(async () => {
      await result.current.signOut();
    });

    expect(api.signout).toHaveBeenCalledOnce();
    expect(result.current.user).toBeNull();
  });

  it('sets user to null on session check failure', async () => {
    vi.mocked(api.getSession).mockRejectedValueOnce(new Error('Network error'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.user).toBeNull();
  });
  // The API returns the success shape for an email that is already registered,
  // so that signup cannot be used to probe which addresses have accounts. The
  // only visible difference is that no auth cookie is set — so the client has
  // to notice the missing session and say something, or the user is silently
  // dropped on an unauthenticated page.
  describe('signUp when no session is established', () => {
    const SIGNUP_DATA = {
      email: 'taken@example.com',
      password: 'password123',
      name: 'T',
      tenantName: 'T',
    };

    it('throws a generic message when the API returns 2xx but no session follows', async () => {
      vi.mocked(api.getSession).mockResolvedValue({ user: null });
      vi.mocked(api.signup).mockResolvedValueOnce({
        message: 'Signup successful',
        user: { id: null, email: 'taken@example.com', name: 'T', tenant: { id: null, name: 'T' } },
      } as unknown as Awaited<ReturnType<typeof api.signup>>);

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      // Catch inside act(): letting the rejection escape act() surfaces as an
      // unhandled rejection in React's test scheduler rather than a clean
      // assertion failure.
      let thrown: Error | null = null;
      await act(async () => {
        await result.current.signUp(SIGNUP_DATA).catch((e: Error) => {
          thrown = e;
        });
      });

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown!.message).toMatch(/could not sign you in automatically/i);
      expect(result.current.user).toBeNull();
    });

    // If the message named the cause, it would reintroduce the oracle it
    // exists to close.
    it('does not reveal that the email is already registered', async () => {
      vi.mocked(api.getSession).mockResolvedValue({ user: null });
      vi.mocked(api.signup).mockResolvedValueOnce({
        message: 'Signup successful',
        user: { id: null, email: 'taken@example.com', name: 'T', tenant: { id: null, name: 'T' } },
      } as unknown as Awaited<ReturnType<typeof api.signup>>);

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let message = '';
      await act(async () => {
        await result.current.signUp(SIGNUP_DATA).catch((e: Error) => {
          message = e.message;
        });
      });

      expect(message).not.toMatch(/already|exists|registered|taken|duplicate/i);
    });

    it('returns normally when a session IS established', async () => {
      const mockUser: User = { id: '1', email: 'new@example.com', name: 'N' };
      vi.mocked(api.getSession).mockResolvedValue({ user: mockUser });
      vi.mocked(api.signup).mockResolvedValueOnce({
        message: 'Signup successful',
        user: mockUser,
      } as unknown as Awaited<ReturnType<typeof api.signup>>);

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.signUp({ ...SIGNUP_DATA, email: 'new@example.com' });
      });

      await waitFor(() => expect(result.current.user).toEqual(mockUser));
    });
  });
});
