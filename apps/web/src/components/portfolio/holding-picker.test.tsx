import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { HoldingPicker } from './holding-picker';
import type { HoldingOption } from '@/lib/portfolio-holding';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : k),
    i18n: { language: 'en' },
  }),
}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

const opt = (over: Partial<HoldingOption>): HoldingOption => ({
  key: over.symbol ?? 'X',
  symbol: 'X',
  name: 'Stocks',
  group: 'Stocks',
  categoryType: 'Investments',
  isDebt: false,
  isCash: false,
  isClosed: false,
  value: 100,
  itemIds: [1],
  ...over,
});

const OPTIONS: HoldingOption[] = [
  opt({ symbol: 'AAPL', value: 10000 }),
  opt({ symbol: 'SNAP', value: 500 }),
  opt({ symbol: 'VWRL', group: 'ETFs', name: 'ETFs', value: 9000 }),
  opt({ symbol: 'TSLA', isClosed: true, value: 0 }),
];

function setup(props: Partial<Parameters<typeof HoldingPicker>[0]> = {}) {
  const onSelect = vi.fn();
  const onClear = vi.fn();
  const user = userEvent.setup();
  const { unmount } = render(
    <HoldingPicker options={OPTIONS} selected={null} currency="USD" onSelect={onSelect} onClear={onClear} {...props} />,
  );
  return { user, onSelect, onClear, unmount };
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId('holding-picker-trigger'));
  return screen.getByPlaceholderText('portfolio.searchHoldings');
};

describe('HoldingPicker', () => {
  it('shows the placeholder and no clear button without a selection', () => {
    setup();
    expect(screen.getByTestId('holding-picker-trigger')).toHaveTextContent('portfolio.allHoldings');
    expect(screen.getByTestId('holding-picker-trigger')).toHaveAttribute('aria-label', 'portfolio.holdingPickerLabel');
    expect(screen.queryByTestId('holding-picker-clear')).not.toBeInTheDocument();
  });

  it('lists open holdings grouped by category group and filters as the user types', async () => {
    const { user } = setup();
    const input = await open(user);
    const headings = Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent);
    expect(headings).toEqual(['Stocks', 'ETFs']);
    expect(screen.queryByTestId('holding-option-TSLA')).not.toBeInTheDocument();

    await user.type(input, 'ap');
    expect(screen.getByTestId('holding-option-AAPL')).toBeInTheDocument();
    expect(screen.getByTestId('holding-option-SNAP')).toBeInTheDocument();
    expect(screen.queryByTestId('holding-option-VWRL')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'zzz');
    expect(screen.getByText('portfolio.noHoldingsFound')).toBeInTheDocument();
  });

  it('adds closed positions, labelled and after the open ones, when toggled', async () => {
    const { user } = setup();
    await open(user);
    await user.click(screen.getByRole('switch', { name: 'portfolio.showClosedPositionsToggle' }));

    const tsla = screen.getByTestId('holding-option-TSLA');
    expect(within(tsla).getByText('portfolio.closedBadge')).toBeInTheDocument();
    const keys = screen.getAllByTestId(/^holding-option-/).map((el) => el.dataset.testid);
    expect(keys[keys.length - 1]).toBe('holding-option-TSLA');
    expect(screen.getByText('portfolio.closedPositionsGroup')).toBeInTheDocument();
  });

  it('starts with the closed toggle off on every mount', async () => {
    const first = setup();
    await open(first.user);
    await first.user.click(screen.getByRole('switch', { name: 'portfolio.showClosedPositionsToggle' }));
    first.unmount();

    const second = setup();
    await open(second.user);
    expect(screen.getByRole('switch', { name: 'portfolio.showClosedPositionsToggle' })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows a closed selection while the toggle is off', () => {
    setup({ selected: OPTIONS[3] });
    expect(screen.getByTestId('holding-picker-trigger')).toHaveTextContent('TSLA');
  });

  it('selects with a click and clears with ×', async () => {
    const { user, onSelect, onClear } = setup({ selected: OPTIONS[0] });
    await open(user);
    await user.click(screen.getByTestId('holding-option-VWRL'));
    expect(onSelect).toHaveBeenCalledWith('VWRL');

    await user.click(screen.getByTestId('holding-picker-clear'));
    expect(onClear).toHaveBeenCalled();
  });

  it('supports the keyboard: ArrowDown + Enter selects', async () => {
    const { user, onSelect } = setup();
    await open(user);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(['AAPL', 'SNAP', 'VWRL']).toContain(onSelect.mock.calls[0][0]);
  });
});
