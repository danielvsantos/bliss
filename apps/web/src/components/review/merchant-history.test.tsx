import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MerchantHistory } from './merchant-history';
import * as UseMerchantHistory from '@/hooks/use-merchant-history';

vi.mock('@/hooks/use-merchant-history');

describe('MerchantHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(UseMerchantHistory.useMerchantHistory).mockReturnValue({
      data: undefined,
      isLoading: false
    } as any);
  });

  it('renders nothing if description is absent', () => {
    const { container } = render(<MerchantHistory description={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders loading state', () => {
    vi.mocked(UseMerchantHistory.useMerchantHistory).mockReturnValue({
      data: undefined,
      isLoading: true
    } as any);

    const { container } = render(<MerchantHistory description="Target" />);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders empty state if no history found', () => {
    vi.mocked(UseMerchantHistory.useMerchantHistory).mockReturnValue({
      data: [],
      isLoading: false
    } as any);

    render(<MerchantHistory description="Target" />);
    expect(screen.getByText('No previous transactions found for this merchant.')).toBeInTheDocument();
  });

  it('renders a list of transaction history correctly', () => {
    vi.mocked(UseMerchantHistory.useMerchantHistory).mockReturnValue({
      data: [
        {
          id: 1,
          transaction_date: '2023-11-20',
          credit: 0,
          debit: 50.25,
          currency: 'USD',
          category: { name: 'Retail' }
        },
        {
          id: 2,
          transaction_date: '2023-10-15',
          credit: 12.00, // For instance, a return
          debit: 0,
          currency: 'USD',
          category: null // Test fallback to 'Uncategorized'
        }
      ],
      isLoading: false
    } as any);

    render(<MerchantHistory description="Target" />);

    expect(screen.getByText('Retail')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    
    // Check formatting - positive and negative
    expect(screen.getByText('+$12.00')).toBeInTheDocument();
    expect(screen.getByText('-$50.25')).toBeInTheDocument();
  });
});
