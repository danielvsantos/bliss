import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ViewToggle } from './view-toggle';

describe('ViewToggle', () => {
  it('renders "Grouped" button', () => {
    render(<ViewToggle viewMode="flat" onChange={vi.fn()} />);
    expect(screen.getByText('Grouped')).toBeInTheDocument();
  });

  it('calls onChange with "grouped" when in flat mode', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ViewToggle viewMode="flat" onChange={onChange} />);
    await user.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('grouped');
  });

  it('calls onChange with "flat" when in grouped mode', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ViewToggle viewMode="grouped" onChange={onChange} />);
    await user.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('flat');
  });

  it('applies primary style when grouped mode is active', () => {
    render(<ViewToggle viewMode="grouped" onChange={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveClass('bg-primary');
  });

  it('applies muted style when flat mode is active', () => {
    render(<ViewToggle viewMode="flat" onChange={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveClass('bg-muted');
  });
});
