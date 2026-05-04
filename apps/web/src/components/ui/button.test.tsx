import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('renders with default variant', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('renders with destructive variant', () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toBeInTheDocument();
  });

  it('renders with outline variant', () => {
    render(<Button variant="outline">Outline</Button>);
    expect(screen.getByRole('button', { name: 'Outline' })).toBeInTheDocument();
  });

  it('renders with secondary variant', () => {
    render(<Button variant="secondary">Secondary</Button>);
    expect(screen.getByRole('button', { name: 'Secondary' })).toBeInTheDocument();
  });

  it('renders with ghost variant', () => {
    render(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole('button', { name: 'Ghost' })).toBeInTheDocument();
  });

  it('renders with link variant', () => {
    render(<Button variant="link">Link</Button>);
    expect(screen.getByRole('button', { name: 'Link' })).toBeInTheDocument();
  });

  it('renders with sm size', () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button', { name: 'Small' })).toBeInTheDocument();
  });

  it('renders with lg size', () => {
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole('button', { name: 'Large' })).toBeInTheDocument();
  });

  it('renders with icon size', () => {
    render(<Button size="icon" aria-label="icon-btn">★</Button>);
    expect(screen.getByRole('button', { name: 'icon-btn' })).toBeInTheDocument();
  });

  it('fires onClick when clicked', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Click' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is disabled when disabled prop set', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button', { name: 'Disabled' })).toBeDisabled();
  });

  it('renders as child when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/home" data-testid="link-btn">Home</a>
      </Button>
    );
    const link = screen.getByTestId('link-btn');
    expect(link.tagName.toLowerCase()).toBe('a');
  });

  it('applies custom className', () => {
    render(<Button className="custom-class">Custom</Button>);
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveClass('custom-class');
  });
});
