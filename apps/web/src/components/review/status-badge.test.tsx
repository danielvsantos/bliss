import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StatusBadge } from './status-badge';
import type { TxStatus } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('StatusBadge', () => {
  const statuses: TxStatus[] = [
    'ai-approved',
    'new-merchant',
    'needs-enrichment',
    'low-confidence',
    'duplicate',
    'potential-duplicate',
  ];

  it('renders a badge for each status', () => {
    for (const status of statuses) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(/review\./)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders ai-approved with positive color', () => {
    render(<StatusBadge status="ai-approved" />);
    expect(screen.getByText('review.confident')).toHaveClass('text-positive');
  });

  it('renders new-merchant with brand-primary color', () => {
    render(<StatusBadge status="new-merchant" />);
    expect(screen.getByText('review.newMerchant')).toHaveClass('text-brand-primary');
  });

  it('renders low-confidence with destructive color', () => {
    render(<StatusBadge status="low-confidence" />);
    expect(screen.getByText('review.uncertain')).toHaveClass('text-destructive');
  });

  it('renders duplicate with destructive color', () => {
    render(<StatusBadge status="duplicate" />);
    expect(screen.getByText('review.duplicate')).toHaveClass('text-destructive');
  });

  it('renders needs-enrichment with warning color', () => {
    render(<StatusBadge status="needs-enrichment" />);
    expect(screen.getByText('review.actionNeeded')).toHaveClass('text-warning');
  });

  it('renders potential-duplicate with warning color', () => {
    render(<StatusBadge status="potential-duplicate" />);
    expect(screen.getByText('review.possibleDup')).toHaveClass('text-warning');
  });
});
