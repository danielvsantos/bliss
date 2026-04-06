import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaidConnect } from './plaid-connect';
import { api } from '@/lib/api';
import * as ReactPlaidLink from 'react-plaid-link';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Mock API and external libraries
vi.mock('@/lib/api');
vi.mock('@/hooks/use-toast', () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() }))
}));

// We must store the configuration passed to usePlaidLink to simulate an onSuccess callback
let capturedPlaidConfig: any;
vi.mock('react-plaid-link', () => ({
  usePlaidLink: vi.fn((config) => {
    capturedPlaidConfig = config;
    return {
      open: vi.fn(),
      ready: !!config.token,
    };
  }),
}));

// Mock the child modal
vi.mock('./account-selection-modal', () => ({
  AccountSelectionModal: ({ isOpen, onClose }: any) => isOpen ? (
    <div data-testid="mock-account-modal">
      <button onClick={onClose}>Close Modal</button>
    </div>
  ) : null
}));

describe('PlaidConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes a link token and renders ready state', async () => {
    vi.mocked(api.createLinkToken).mockResolvedValueOnce({ link_token: 'link-123' });

    render(<PlaidConnect />);
    
    // Initially checking for loading spinner or disabled state
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();

    // After token returns, button enables
    await waitFor(() => {
      expect(api.createLinkToken).toHaveBeenCalledWith(undefined);
      expect(button).toBeEnabled();
    });

    expect(screen.getByText('plaidConnect.connectBank')).toBeInTheDocument();
  });

  it('dispatches the exchangePublicToken call automatically on success', async () => {
    vi.mocked(api.createLinkToken).mockResolvedValueOnce({ link_token: 'link-123' });
    vi.mocked(api.exchangePublicToken).mockResolvedValueOnce({ plaidItemId: 'item-123' });

    render(<PlaidConnect />);
    
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());

    // Simulate react-plaid-link `onSuccess` firing internally
    expect(capturedPlaidConfig).toBeDefined();
    await capturedPlaidConfig.onSuccess('public-token-abc', { institution: { name: 'Chase' } });

    expect(api.exchangePublicToken).toHaveBeenCalledWith('public-token-abc', { institution: { name: 'Chase' } });
    
    // This pops the Account Selection Modal internally
    const modal = await screen.findByTestId('mock-account-modal');
    expect(modal).toBeInTheDocument();
  });

  it('updates an existing item instead of exchanging if plaidItemId is provided', async () => {
    vi.mocked(api.createLinkToken).mockResolvedValueOnce({ link_token: 'link-update-456' });
    vi.mocked(api.updatePlaidItem).mockResolvedValueOnce({ success: true });

    render(<PlaidConnect plaidItemId="existing-item-999" />);
    
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    expect(screen.getByText('plaidConnect.reconnect')).toBeInTheDocument();

    // Simulate react-plaid-link returning success (e.g user typed in their updated bank password)
    await capturedPlaidConfig.onSuccess('public-token-123', {});

    // For updates, the item goes to ACTIVE status
    expect(api.updatePlaidItem).toHaveBeenCalledWith('existing-item-999', { status: 'ACTIVE' });
    expect(api.exchangePublicToken).not.toHaveBeenCalled();
    // Modal shouldn't show directly because we just update instead of picking accounts
    expect(screen.queryByTestId('mock-account-modal')).not.toBeInTheDocument();
  });

  it('executes a custom onSuccess callback if provided unconditionally in update mode', async () => {
    vi.mocked(api.createLinkToken).mockResolvedValueOnce({ link_token: 'link-123' });
    vi.mocked(api.updatePlaidItem).mockResolvedValueOnce({ success: true });
    
    const customSuccess = vi.fn();
    render(<PlaidConnect plaidItemId="item-existing" onSuccess={customSuccess} />);
    
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    await capturedPlaidConfig.onSuccess('custom-public-token', { myData: true });

    // Validate we called both the background re-auth logic AND the custom
    expect(api.updatePlaidItem).toHaveBeenCalled();
    expect(customSuccess).toHaveBeenCalledWith('custom-public-token', { myData: true });
  });
});
