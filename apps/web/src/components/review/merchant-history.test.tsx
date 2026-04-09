import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { MerchantHistory } from './merchant-history';
import * as UseMerchantHistory from '@/hooks/use-merchant-history';
import { mockQueryResult, mockQueryLoading } from '@/test/mock-helpers';

vi.mock('@/hooks/use-merchant-history');

describe('MerchantHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(UseMerchantHistory.useMerchantHistory).mockReturnValue(
      mockQueryResult(undefined),
    );
  });

  it('renders nothing if description is absent', () => {
    const { container } = render(<MerchantHistory description={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders loading state', () => {
    vi.mocked(UseMerchantHistory.useMerchantHistory).mockReturnValue(mockQueryLoading());

    const { container } = render(<MerchantHistory description="Target" />);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders empty state if no history found', () => {
    vi.mocked(UseMerchantHistory.useMerchantHistory).mockReturnValue(mockQueryResult([]));

    render(<MerchantHistory description="Target" />);
    expect(screen.getByText('review.noMerchantHistory')).toBeInTheDocument();
  });

  it('renders a list of transaction history correctly', () => {
    vi.mocked(UseMerchantHistory.useMerchantHistory).mockReturnValue(
      mockQueryResult([
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
      ]),
    );

    render(<MerchantHistory description="Target" />);

    expect(screen.getByText('Retail')).toBeInTheDocument();
    expect(screen.getByText('review.uncategorized')).toBeInTheDocument();
    
    // Check formatting - positive and negative
    expect(screen.getByText('+$12.00')).toBeInTheDocument();
    expect(screen.getByText('-$50.25')).toBeInTheDocument();
  });
});
