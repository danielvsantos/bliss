import { createContext } from 'react';
import type { User, Tenant } from '../types/api';

export interface SignUpData {
  email: string;
  password?: string;
  name?: string;
  tenantName: string;
  countries: string[];
  currencies: string[];
  bankIds?: number[];
}

export interface SignInData {
  email: string;
  password: string;
}

export interface SignUpResponse {
  user: User;
  tenant: Tenant;
}

export interface GoogleSignInOptions {
  /** Path to land on after Google (the confirm-identity step-up, #156). */
  returnTo?: string;
  /** Google `prompt`; the step-up uses `select_account` to force a choice. */
  prompt?: 'select_account';
}

export interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  googleOAuthEnabled: boolean;
  signUp: (data: SignUpData) => Promise<SignUpResponse>;
  signIn: (data: SignInData) => Promise<void>;
  signInWithGoogle: (options?: GoogleSignInOptions) => Promise<void>;
  signOut: () => Promise<void>;
  /** Resolves to the signed-in user, or null when there is no session. */
  checkSession: () => Promise<User | null>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);
