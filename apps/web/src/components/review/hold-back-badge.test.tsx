import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HoldBackBadge } from './hold-back-badge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts?.fields ? `${k}(${opts.fields})` : k),
  }),
}));

describe('HoldBackBadge', () => {
  it('renders nothing without reasons', () => {
    const { container } = render(<HoldBackBadge reasons={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names every missing investment field in one warning badge', () => {
    render(<HoldBackBadge reasons={['MISSING_QUANTITY', 'MISSING_PRICE']} />);
    const badge = screen.getByText(
      'review.holdBack.missingFields(review.holdBack.fieldQuantity, review.holdBack.fieldPrice)',
    );
    expect(badge).toHaveClass('text-warning');
    expect(screen.getAllByTestId('hold-back-badge')).toHaveLength(1);
  });

  it('adds a separate badge for the account and duplicate reasons', () => {
    render(<HoldBackBadge reasons={['MISSING_TICKER', 'MISSING_ACCOUNT', 'DUPLICATE']} />);
    expect(screen.getAllByTestId('hold-back-badge')).toHaveLength(3);
    expect(screen.getByText('review.holdBack.missingAccount')).toBeInTheDocument();
    expect(screen.getByText('review.holdBack.duplicate')).toBeInTheDocument();
  });
});
