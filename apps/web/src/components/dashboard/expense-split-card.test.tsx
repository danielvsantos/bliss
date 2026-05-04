import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ExpenseSplitCard } from './expense-split-card';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-analytics');
vi.mock('@/lib/category-i18n', () => ({
  translateCategoryGroup: (_t: unknown, group: string) => group,
}));

vi.mock('recharts', () => ({
  PieChart: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="recharts-pie-chart">{children}</div>
  ),
  Pie: () => <g data-testid="recharts-pie" />,
  Cell: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="recharts-container">{children}</div>
  ),
  Tooltip: () => null,
}));

import { useAnalytics } from '@/hooks/use-analytics';

describe('ExpenseSplitCard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the card title', () => {
    vi.mocked(useAnalytics).mockReturnValue({
      data: undefined, isLoading: true, isError: false,
    } as unknown as ReturnType<typeof useAnalytics>);
    render(<MemoryRouter><ExpenseSplitCard currency="USD" /></MemoryRouter>);
    expect(screen.getByText('expenseSplit.title')).toBeInTheDocument();
  });

  it('renders loading skeleton while data is loading', () => {
    vi.mocked(useAnalytics).mockReturnValue({
      data: undefined, isLoading: true, isError: false,
    } as unknown as ReturnType<typeof useAnalytics>);
    const { container } = render(<MemoryRouter><ExpenseSplitCard currency="USD" /></MemoryRouter>);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  });

  it('shows no-data message when analytics returns no group data', () => {
    vi.mocked(useAnalytics).mockReturnValue({
      data: undefined, isLoading: false, isError: false,
    } as unknown as ReturnType<typeof useAnalytics>);
    render(<MemoryRouter><ExpenseSplitCard currency="USD" /></MemoryRouter>);
    expect(screen.getByText('expenseSplit.noData')).toBeInTheDocument();
  });

  it('accepts a custom className', () => {
    vi.mocked(useAnalytics).mockReturnValue({
      data: undefined, isLoading: false, isError: false,
    } as unknown as ReturnType<typeof useAnalytics>);
    const { container } = render(
      <MemoryRouter><ExpenseSplitCard currency="USD" className="test-class" /></MemoryRouter>
    );
    expect(container.querySelector('.test-class')).toBeInTheDocument();
  });

  it('renders select period dropdown', () => {
    vi.mocked(useAnalytics).mockReturnValue({
      data: undefined, isLoading: false, isError: false,
    } as unknown as ReturnType<typeof useAnalytics>);
    render(<MemoryRouter><ExpenseSplitCard currency="USD" /></MemoryRouter>);
    // Period selector is always rendered
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});
