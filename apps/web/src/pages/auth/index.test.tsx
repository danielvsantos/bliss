import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AuthPage from './index';
import * as AuthHook from '@/hooks/use-auth';
import * as TenantMeta from '@/utils/tenantMetaStorage';

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
    } as any);
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
});
