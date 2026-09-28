import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { InsightCard } from './insight-card';
import type { Insight } from '@/types/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const makeInsight = (overrides: Partial<Insight> = {}): Insight => ({
  id: 'insight-1',
  tier: 'MONTHLY',
  lens: 'SPENDING_VELOCITY',
  title: 'Spending increased 12%',
  body: 'Your total spending this month was higher than usual.',
  severity: 'WARNING',
  periodKey: '2025-01',
  dataHash: 'abc123',
  isDismissed: false,
  createdAt: '2025-01-01T00:00:00Z',
  metadata: null,
  ...overrides,
});

describe('InsightCard', () => {
  it('renders the insight title', () => {
    render(<InsightCard insight={makeInsight()} onDismiss={vi.fn()} />);
    expect(screen.getByText('Spending increased 12%')).toBeInTheDocument();
  });

  it('renders the insight body', () => {
    render(<InsightCard insight={makeInsight()} onDismiss={vi.fn()} />);
    expect(screen.getByText('Your total spending this month was higher than usual.')).toBeInTheDocument();
  });

  it('renders lens label for known lens', () => {
    render(<InsightCard insight={makeInsight({ lens: 'SPENDING_VELOCITY' })} onDismiss={vi.fn()} />);
    expect(screen.getByText('Spending')).toBeInTheDocument();
  });

  it('renders tier badge when showTierBadge=true', () => {
    render(<InsightCard insight={makeInsight({ tier: 'MONTHLY' })} onDismiss={vi.fn()} showTierBadge />);
    expect(screen.getByText('Monthly')).toBeInTheDocument();
  });

  it('hides tier badge when showTierBadge=false', () => {
    render(<InsightCard insight={makeInsight()} onDismiss={vi.fn()} showTierBadge={false} />);
    expect(screen.queryByText('Monthly')).not.toBeInTheDocument();
  });

  it('renders periodKey when present', () => {
    render(<InsightCard insight={makeInsight({ periodKey: '2025-Q1' })} onDismiss={vi.fn()} />);
    expect(screen.getByText('2025-Q1')).toBeInTheDocument();
  });

  it('renders suggestedAction from metadata when present', () => {
    render(
      <InsightCard
        insight={makeInsight({ metadata: { suggestedAction: 'Cut dining out budget' } })}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('Cut dining out budget')).toBeInTheDocument();
  });

  it('calls onDismiss with insight id when dismiss button clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<InsightCard insight={makeInsight({ id: 'ins-42' })} onDismiss={onDismiss} />);
    await user.click(screen.getByTitle('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('ins-42');
  });

  it('renders unknown lens as raw lens name', () => {
    render(<InsightCard insight={makeInsight({ lens: 'CUSTOM_LENS' })} onDismiss={vi.fn()} />);
    expect(screen.getByText('CUSTOM_LENS')).toBeInTheDocument();
  });

  it('renders POSITIVE severity', () => {
    const { container } = render(
      <InsightCard insight={makeInsight({ severity: 'POSITIVE' })} onDismiss={vi.fn()} />
    );
    expect(container.querySelector('.border-l-positive')).toBeInTheDocument();
  });

  it('renders all known tier badges', () => {
    for (const [tier, label] of [
      ['MONTHLY', 'Monthly'],
      ['QUARTERLY', 'Quarterly'],
      ['ANNUAL', 'Annual'],
      ['PORTFOLIO', 'Portfolio'],
    ] as const) {
      const { unmount } = render(
        <InsightCard insight={makeInsight({ tier })} onDismiss={vi.fn()} showTierBadge />
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  // ── Passive income (#80) ─────────────────────────────────────────────────
  it('renders the translated PASSIVE_INCOME_OUTLOOK lens label', () => {
    render(<InsightCard insight={makeInsight({ lens: 'PASSIVE_INCOME_OUTLOOK' })} onDismiss={vi.fn()} />);
    expect(screen.getByText('insights.lens.passiveIncomeOutlook')).toBeInTheDocument();
  });

  it('renders no action links for action types without a destination', () => {
    render(
      <InsightCard
        insight={makeInsight({ metadata: { actionTypes: ['INCOME_GROWTH'], suggestedAction: 'Grow income.' } })}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('PASSIVE_INCOME_SETUP links to the Passive Income page and Portfolio holdings', async () => {
    const insight = makeInsight({
      lens: 'PASSIVE_INCOME_OUTLOOK',
      metadata: { actionTypes: ['PASSIVE_INCOME_SETUP'], suggestedAction: 'Add income terms for MSFT.' },
    });
    render(
      <MemoryRouter initialEntries={['/insights']}>
        <Routes>
          <Route path="/insights" element={<InsightCard insight={insight} onDismiss={vi.fn()} />} />
          <Route path="/reports/passive-income" element={<div>Passive income page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const setup = screen.getByRole('link', { name: 'insights.actions.passiveIncomeSetup' });
    expect(setup).toHaveAttribute('href', '/reports/passive-income');
    expect(screen.getByRole('link', { name: 'insights.actions.portfolioHoldings' })).toHaveAttribute('href', '/reports/portfolio');

    await userEvent.click(setup);
    expect(screen.getByText('Passive income page')).toBeInTheDocument();
  });
});
