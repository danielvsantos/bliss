import React from 'react';
import type { ReactNode, ComponentType } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExpenseTrackingPage from './expenses';
import * as UseAnalytics from '@/hooks/use-analytics';
import * as UseMetadata from '@/hooks/use-metadata';
import * as UseTenantSettings from '@/hooks/use-tenant-settings';
import { mockQueryResult } from '@/test/mock-helpers';
import type { AnalyticsResponse } from '@/types/api';

// Pure-function tests for the moving-average calculation live in
// src/lib/trend-utils.test.ts. This file covers the page-level wiring only.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : k),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/utils/tenantMetaStorage', () => ({
  getTenantMeta: () => ({
    countries: [{ id: 'US', name: 'United States', emoji: '🇺🇸' }],
    currencies: [{ id: 'USD', name: 'US Dollar', symbol: '$' }],
    transactionYears: [2023],
  }),
}));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.ResizeObserver = global.ResizeObserver;

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends Event {} as unknown as typeof PointerEvent;
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('@/hooks/use-analytics');
vi.mock('@/hooks/use-metadata');
vi.mock('@/hooks/use-tenant-settings');

type LineProps = { name?: string; stroke?: string; strokeDasharray?: string; strokeOpacity?: number };

vi.mock('recharts', async () => {
  const Original = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...Original,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <Original.ResponsiveContainer width={400} height={400}>
        {children as React.ReactElement}
      </Original.ResponsiveContainer>
    ),
    PieChart: (() => <div data-testid="pie-chart" />) as ComponentType<unknown>,
    Pie: () => null,
    Cell: () => null,
    LineChart: (({ children }: { children: ReactNode }) => (
      <div data-testid="line-chart">{children}</div>
    )) as ComponentType<{ children: ReactNode }>,
    Line: ((props: LineProps) => (
      <div
        data-testid="line"
        data-stroke={props.stroke}
        data-dash={props.strokeDasharray || ''}
        data-opacity={props.strokeOpacity ?? ''}
      >
        {props.name}
      </div>
    )) as ComponentType<LineProps>,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
  };
});

const buildAnalyticsData = (
  months: string[],
  groupValues: Record<string, number[]>
): AnalyticsResponse => {
  const data: Record<string, unknown> = {};
  months.forEach((month, i) => {
    const groups: Record<string, { debit: number; credit: number }> = {};
    Object.entries(groupValues).forEach(([group, values]) => {
      groups[group] = { debit: values[i] ?? 0, credit: 0 };
    });
    data[month] = { Lifestyle: groups };
  });
  return { currency: 'USD', view: 'month', data };
};

describe('ExpenseTrackingPage - Monthly Trends moving average', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(UseMetadata.useUserPreferences).mockReturnValue(
      mockQueryResult({ defaultCurrency: 'USD', defaultCountry: 'US', theme: 'system' as const }),
    );
    vi.mocked(UseMetadata.useCategories).mockReturnValue(
      mockQueryResult([{ id: 1, name: 'Dining Out', group: 'Dining Out', type: 'Lifestyle', tenantId: 't1' }]),
    );
    vi.mocked(UseTenantSettings.useTenantSettings).mockReturnValue(
      mockQueryResult({ autoPromoteThreshold: 0.9, reviewThreshold: 0.7, portfolioCurrency: 'USD', plaidHistoryDays: 30 }),
    );
  });

  const renderPage = () => {
    const user = userEvent.setup();
    const result = render(
      <MemoryRouter>
        <ExpenseTrackingPage />
      </MemoryRouter>
    );
    return { ...result, user };
  };

  // The trends group picker is the last `role="combobox"` element in the DOM
  // while the "trends" tab is active (the type/currency/country pickers in the
  // always-visible filter bar come before it; the other tabs' content is
  // `hidden` by Radix Tabs and excluded from role queries).
  const selectTrendGroup = async (user: ReturnType<typeof userEvent.setup>, groupName: string) => {
    const combobox = screen.getAllByRole('combobox').at(-1);
    if (!combobox) throw new Error('Trend group picker combobox not found');
    await user.click(combobox);
    // The group name can also appear elsewhere on the page (e.g. the "highest
    // category" KPI), so target the cmdk list item specifically by its value.
    const item = await screen.findByText((_, element) =>
      element?.getAttribute('data-slot') === 'command-item' && element?.getAttribute('data-value') === groupName
    );
    await user.click(item);
  };

  it('renders both the de-emphasized raw line and the emphasized dashed average line once >=3 months of data exist', async () => {
    vi.mocked(UseAnalytics.useAnalytics).mockReturnValue(
      mockQueryResult(
        buildAnalyticsData(['2023-01', '2023-02', '2023-03', '2023-04'], { 'Dining Out': [300, 1700, 400, 900] })
      ),
    );

    const { user } = renderPage();
    await user.click(screen.getByText('pages.expenses.breakdown.tabs.monthlyTrends'));
    await selectTrendGroup(user, 'Dining Out');

    const lines = screen.getAllByTestId('line');
    expect(lines).toHaveLength(2);

    const rawLine = lines.find(l => l.textContent === 'Dining Out');
    const avgLine = lines.find(l => l.textContent === 'Dining Outpages.expenses.breakdown.trendChart.movingAverageSuffix');

    expect(rawLine).toBeDefined();
    expect(avgLine).toBeDefined();

    // Raw line is de-emphasized (reduced opacity), average line is the emphasized dashed series.
    expect(Number(rawLine?.dataset.opacity)).toBeLessThan(1);
    expect(avgLine?.dataset.dash).not.toBe('');

    // Both lines share the same per-group color -- opacity/dash is the only differentiator.
    expect(rawLine?.dataset.stroke).toBe(avgLine?.dataset.stroke);
  });

  it('renders only the raw line when fewer than 3 months of data exist for the selected group', async () => {
    vi.mocked(UseAnalytics.useAnalytics).mockReturnValue(
      mockQueryResult(buildAnalyticsData(['2023-01', '2023-02'], { 'Dining Out': [300, 400] })),
    );

    const { user } = renderPage();
    await user.click(screen.getByText('pages.expenses.breakdown.tabs.monthlyTrends'));
    await selectTrendGroup(user, 'Dining Out');

    const lines = screen.getAllByTestId('line');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe('Dining Out');
    // No average to de-emphasize against, so the raw line stays at full opacity.
    expect(Number(lines[0].dataset.opacity)).toBe(1);
  });

  it('keeps each group\'s raw/average pair on a consistent color when multiple groups are selected', async () => {
    vi.mocked(UseMetadata.useCategories).mockReturnValue(
      mockQueryResult([
        { id: 1, name: 'Dining Out', group: 'Dining Out', type: 'Lifestyle', tenantId: 't1' },
        { id: 2, name: 'Groceries', group: 'Groceries', type: 'Essentials', tenantId: 't1' },
      ]),
    );
    vi.mocked(UseAnalytics.useAnalytics).mockReturnValue(
      mockQueryResult(
        buildAnalyticsData(
          ['2023-01', '2023-02', '2023-03', '2023-04'],
          { 'Dining Out': [300, 1700, 400, 900], Groceries: [200, 250, 300, 210] }
        ),
      ),
    );

    const { user } = renderPage();
    await user.click(screen.getByText('pages.expenses.breakdown.tabs.monthlyTrends'));
    await selectTrendGroup(user, 'Dining Out');
    await selectTrendGroup(user, 'Groceries');

    const lines = screen.getAllByTestId('line');
    expect(lines).toHaveLength(4);

    const diningRaw = lines.find(l => l.textContent === 'Dining Out');
    const diningAvg = lines.find(l => l.textContent === 'Dining Outpages.expenses.breakdown.trendChart.movingAverageSuffix');
    const groceriesRaw = lines.find(l => l.textContent === 'Groceries');
    const groceriesAvg = lines.find(l => l.textContent === 'Groceriespages.expenses.breakdown.trendChart.movingAverageSuffix');

    expect(diningRaw?.dataset.stroke).toBe(diningAvg?.dataset.stroke);
    expect(groceriesRaw?.dataset.stroke).toBe(groceriesAvg?.dataset.stroke);
    expect(diningRaw?.dataset.stroke).not.toBe(groceriesRaw?.dataset.stroke);

    // Every average line is identifiable as the dashed, emphasized series regardless of group.
    [diningAvg, groceriesAvg].forEach(line => expect(line?.dataset.dash).not.toBe(''));
    [diningRaw, groceriesRaw].forEach(line => expect(Number(line?.dataset.opacity)).toBeLessThan(1));
  });
});
