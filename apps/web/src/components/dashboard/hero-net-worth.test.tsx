import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HeroNetWorth } from './hero-net-worth';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Sparkline uses recharts which can be complex in jsdom; mock it
vi.mock('./net-worth-sparkline', () => ({
  NetWorthSparkline: () => <div data-testid="sparkline" />,
}));

const defaultProps = {
  netWorth: 100000,
  previousNetWorth: 90000,
  income: 5000,
  netSavings: 1500,
  currency: 'USD',
  lastSyncDate: '2024-01-15T00:00:00Z',
  sparklineData: [80000, 85000, 90000, 95000, 100000],
  isLoading: false,
};

describe('HeroNetWorth', () => {
  it('renders the net worth value', () => {
    render(<HeroNetWorth {...defaultProps} />);
    // The formatted net worth should appear
    expect(screen.getByText(/100,000|100\.000/)).toBeInTheDocument();
  });

  it('renders skeleton while loading', () => {
    const { container } = render(<HeroNetWorth {...defaultProps} isLoading />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders sparkline component', () => {
    render(<HeroNetWorth {...defaultProps} />);
    expect(screen.getByTestId('sparkline')).toBeInTheDocument();
  });

  it('renders with no previous net worth (null delta)', () => {
    render(<HeroNetWorth {...defaultProps} previousNetWorth={null} />);
    expect(screen.getByText(/100,000|100\.000/)).toBeInTheDocument();
  });

  it('renders with negative delta (net worth decreased)', () => {
    render(<HeroNetWorth {...defaultProps} netWorth={80000} previousNetWorth={100000} />);
    expect(screen.getByText(/80,000|80\.000/)).toBeInTheDocument();
  });

  it('renders with null lastSyncDate', () => {
    render(<HeroNetWorth {...defaultProps} lastSyncDate={null} />);
    expect(screen.getByText(/100,000|100\.000/)).toBeInTheDocument();
  });
});
