import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Input } from './input';

describe('Input', () => {
  it('renders an input element', () => {
    render(<Input data-testid="inp" />);
    expect(screen.getByTestId('inp')).toBeInTheDocument();
  });

  it('has data-slot="input"', () => {
    render(<Input data-testid="inp" />);
    expect(screen.getByTestId('inp')).toHaveAttribute('data-slot', 'input');
  });

  it('renders with placeholder', () => {
    render(<Input placeholder="Enter name" />);
    expect(screen.getByPlaceholderText('Enter name')).toBeInTheDocument();
  });

  it('renders without explicit type when none provided', () => {
    render(<Input data-testid="inp" />);
    // Browser default type is text but the attribute may not be explicitly set
    const el = screen.getByTestId('inp');
    const typeAttr = el.getAttribute('type');
    expect(typeAttr === null || typeAttr === 'text').toBe(true);
  });

  it('renders with explicit type', () => {
    render(<Input type="email" data-testid="inp" />);
    expect(screen.getByTestId('inp')).toHaveAttribute('type', 'email');
  });

  it('renders password type', () => {
    render(<Input type="password" data-testid="inp" />);
    expect(screen.getByTestId('inp')).toHaveAttribute('type', 'password');
  });

  it('renders number type', () => {
    render(<Input type="number" data-testid="inp" />);
    expect(screen.getByTestId('inp')).toHaveAttribute('type', 'number');
  });

  it('fires onChange when value changes', () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} data-testid="inp" />);
    fireEvent.change(screen.getByTestId('inp'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('is disabled when disabled prop set', () => {
    render(<Input disabled data-testid="inp" />);
    expect(screen.getByTestId('inp')).toBeDisabled();
  });

  it('applies custom className', () => {
    render(<Input className="custom-input" data-testid="inp" />);
    expect(screen.getByTestId('inp')).toHaveClass('custom-input');
  });

  it('renders with defaultValue', () => {
    render(<Input defaultValue="pre-filled" data-testid="inp" />);
    expect(screen.getByTestId('inp')).toHaveValue('pre-filled');
  });
});
