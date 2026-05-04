import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TrendingUp } from 'lucide-react';
import { MetricsCard } from './metrics-card';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('MetricsCard', () => {
  const defaultProps = {
    title: 'Net Worth',
    value: 50000,
    change: 5.2,
    currency: 'USD',
    icon: <TrendingUp />,
  };

  it('renders the title', () => {
    render(<MetricsCard {...defaultProps} />);
    expect(screen.getByText('Net Worth')).toBeInTheDocument();
  });

  it('renders formatted value', () => {
    render(<MetricsCard {...defaultProps} value={50000} currency="USD" />);
    // formatCurrency should format as $50,000
    expect(screen.getByText(/50,000/)).toBeInTheDocument();
  });

  it('renders positive change with up arrow', () => {
    render(<MetricsCard {...defaultProps} change={5.2} />);
    expect(screen.getByText('5.2%')).toBeInTheDocument();
    // Sr-only text for up
    expect(screen.getByText(/Increased/)).toBeInTheDocument();
  });

  it('renders negative change with down arrow', () => {
    render(<MetricsCard {...defaultProps} change={-3.1} />);
    expect(screen.getByText('3.1%')).toBeInTheDocument();
    expect(screen.getByText(/Decreased/)).toBeInTheDocument();
  });

  it('does not render change indicator when change is 0', () => {
    render(<MetricsCard {...defaultProps} change={0} />);
    expect(screen.queryByText(/Increased/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Decreased/)).not.toBeInTheDocument();
  });

  it('renders icon', () => {
    const { container } = render(<MetricsCard {...defaultProps} icon={<svg data-testid="icon" />} />);
    expect(container.querySelector('[data-testid="icon"]')).toBeInTheDocument();
  });

  it('defaults to USD when no currency supplied', () => {
    render(
      <MetricsCard title="Test" value={1000} change={0} icon={<TrendingUp />} />
    );
    // Should render the formatted value - USD is the default
    expect(screen.getByText(/1,000/)).toBeInTheDocument();
  });
});
