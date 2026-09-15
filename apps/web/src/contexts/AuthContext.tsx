import React, { useState, useEffect } from 'react';
import api from '../lib/api';
import { AxiosError } from 'axios';
import type { User } from '../types/api';
import { updateTenantMetaFromAPI } from '@/utils/tenantMetaStorage';
import { toast } from '@/hooks/use-toast';
import {
  AuthContext,
  type SignUpData,
  type SignInData,
  type SignUpResponse,
} from './auth-context-value';

interface APIErrorResponse {
  message: string;
  error?: string;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [googleOAuthEnabled, setGoogleOAuthEnabled] = useState(false);

  useEffect(() => {
    checkSession();
    const apiUrl = (import.meta.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000').replace(/\/$/, '');
    fetch(`${apiUrl}/api/auth/providers`, { credentials: 'include' })
      .then(r => r.json())
      .then(providers => setGoogleOAuthEnabled('google' in providers))
      .catch(() => setGoogleOAuthEnabled(false));
  }, []);

  // Listen for session-expired events fired by the API client on 401 responses
  useEffect(() => {
    const handleSessionExpired = () => {
      setUser(null);
      toast({
        title: 'Session expired',
        description: 'Your session has expired. Please sign in again.',
        variant: 'destructive',
      });
    };
    window.addEventListener('auth:session-expired', handleSessionExpired);
    return () => window.removeEventListener('auth:session-expired', handleSessionExpired);
  }, []);

  // Returns the resolved user (or null) so callers can tell whether a session
  // was actually established, not just whether the request threw.
  const checkSession = async () => {
    try {
      setLoading(true);
      const session = await api.getSession();
      if (session?.user) {
        setUser(session.user);
        // Also update tenant meta when session is checked
        if (session.user.tenant?.id) {
          await updateTenantMetaFromAPI(session.user.tenant.id);
        }
        return session.user;
      }
      setUser(null);
      return null;
    } catch (error: unknown) {
      // A 401 is expected when the user is not logged in — not worth logging.
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status !== 401) {
        console.error('Session check failed:', error);
      }
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const signUp = async (data: SignUpData): Promise<SignUpResponse> => {
    try {
      setError(null);
      const response = await api.signup({
        ...data,
        countries: data.countries || ['US'],
        currencies: data.currencies || ['USD'],
        bankIds: data.bankIds || []
      });
      // Cookie is set server-side; verify the session immediately after signup.
      const sessionUser = await checkSession();
      if (!data.password) {
        await signInWithGoogle();
        return response;
      }

      // No session despite a 2xx. The API deliberately returns the success
      // shape for an email that is already registered, so that signup cannot
      // be used to probe which addresses have accounts — the only visible
      // difference is that no auth cookie was set. This message is therefore
      // intentionally generic: it must read the same whether the address was
      // taken or something else went wrong, or it would reintroduce the
      // oracle it exists to close.
      if (!sessionUser) {
        throw new Error(
          'We could not sign you in automatically. Please try signing in with your password.'
        );
      }

      return response;
    } catch (error) {
      const axiosError = error as AxiosError<APIErrorResponse>;
      const errorMessage = axiosError.response?.data?.message
        || axiosError.response?.data?.error
        // An Error we threw ourselves (the no-session branch above) has no
        // axios response, so without this it would be flattened into the
        // generic fallback and its specific guidance lost.
        || (error instanceof Error ? error.message : undefined)
        || 'Failed to create account. Please try again.';
      setError(errorMessage);
      setUser(null);
      throw new Error(errorMessage);
    }
  };

  const signIn = async (data: SignInData) => {
    try {
      setError(null);
      await api.signin(data);
      // Cookie is set server-side; verify the session immediately after signin
      await checkSession();
    } catch (error) {
      const axiosError = error as AxiosError<APIErrorResponse>;
      const errorMessage = axiosError.response?.data?.message
        || axiosError.response?.data?.error
        || 'Invalid email or password.';
      setError(errorMessage);
      setUser(null);
      throw new Error(errorMessage);
    }
  };

  const signInWithGoogle = async () => {
    try {
      setError(null);
      const apiUrl = (import.meta.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000').replace(/\/$/, '');

      // Step 1: fetch CSRF token cross-origin (NextAuth requires this for OAuth initiation)
      const csrfRes = await fetch(`${apiUrl}/api/auth/csrf`, { credentials: 'include' });
      const { csrfToken } = await csrfRes.json();

      // Step 2: submit a form POST — the correct NextAuth v4 pattern to trigger an OAuth redirect
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = `${apiUrl}/api/auth/signin/google`;

      const addHidden = (name: string, value: string) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      };

      addHidden('csrfToken', csrfToken);
      addHidden('callbackUrl', `${apiUrl}/api/auth/google-token`);

      document.body.appendChild(form);
      form.submit();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to sign in with Google.';
      setError(errorMessage);
      throw new Error(errorMessage);
    }
  };

  const signOut = async () => {
    try {
      setError(null);
      await api.signout(); // Server clears the HttpOnly cookie
      setUser(null);
    } catch (error) {
      setError((error as Error).message || 'Sign out failed');
      throw error;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        googleOAuthEnabled,
        signUp,
        signIn,
        signInWithGoogle,
        signOut,
        checkSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
