import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Input } from './input';

describe('Input (custom)', () => {
  it('renders an input element', () => {
    render(<Input data-testid="inp" />);
    expect(screen.getByTestId('inp')).toBeInTheDocument();
  });

  it('renders label when label prop is provided', () => {
    render(<Input label="Email" />);
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('renders hint text', () => {
    render(<Input hint="Must be 8 characters" />);
    expect(screen.getByText('Must be 8 characters')).toBeInTheDocument();
  });

  it('renders error message (overrides hint)', () => {
    render(<Input hint="Some hint" error="Field is required" />);
    // Error should override hint
    expect(screen.getByText('Field is required')).toBeInTheDocument();
    expect(screen.queryByText('Some hint')).not.toBeInTheDocument();
  });

  it('renders with placeholder', () => {
    render(<Input placeholder="Enter value" />);
    expect(screen.getByPlaceholderText('Enter value')).toBeInTheDocument();
  });

  it('renders leftIcon', () => {
    render(<Input leftIcon={<svg data-testid="li" />} />);
    expect(screen.getByTestId('li')).toBeInTheDocument();
  });

  it('renders rightIcon', () => {
    render(<Input rightIcon={<svg data-testid="ri" />} />);
    expect(screen.getByTestId('ri')).toBeInTheDocument();
  });

  it('renders check icon when success=true and no rightIcon', () => {
    const { container } = render(<Input success />);
    // Check icon is a circle+path SVG
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('fires onChange', () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} data-testid="inp" />);
    fireEvent.change(screen.getByTestId('inp'), { target: { value: 'test' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('is disabled when disabled prop is set', () => {
    render(<Input disabled data-testid="inp" />);
    expect(screen.getByTestId('inp')).toBeDisabled();
  });

  it('renders with type password', () => {
    render(<Input type="password" data-testid="inp" />);
    expect(screen.getByTestId('inp')).toHaveAttribute('type', 'password');
  });

  it('label is linked to input via id', () => {
    render(<Input label="Username" />);
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });
});
