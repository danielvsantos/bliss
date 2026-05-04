import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Card, CardHeader, CardTitle, CardDescription, CardDivider, CardFooter } from './card';

describe('Card (custom liquid glass)', () => {
  it('renders children', () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<Card className="custom-card">X</Card>);
    expect(container.firstChild).toHaveClass('custom-card');
  });

  it('renders with noBlur style', () => {
    const { container } = render(<Card noBlur>X</Card>);
    const el = container.firstChild as HTMLElement;
    expect(el.style.backdropFilter).toBe('none');
  });

  it('renders with interactive class when interactive=true', () => {
    const { container } = render(<Card interactive>X</Card>);
    expect(container.firstChild).toHaveClass('cursor-pointer');
  });

  it('renders without interactive class by default', () => {
    const { container } = render(<Card>X</Card>);
    expect(container.firstChild).not.toHaveClass('cursor-pointer');
  });
});

describe('CardHeader', () => {
  it('renders children', () => {
    render(<CardHeader>Header content</CardHeader>);
    expect(screen.getByText('Header content')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<CardHeader className="custom-header">X</CardHeader>);
    expect(container.firstChild).toHaveClass('custom-header');
  });
});

describe('CardTitle', () => {
  it('renders title text', () => {
    render(<CardTitle>My Title</CardTitle>);
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('renders as an h3 element', () => {
    render(<CardTitle>Title</CardTitle>);
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
  });
});

describe('CardDescription', () => {
  it('renders description text', () => {
    render(<CardDescription>Some description</CardDescription>);
    expect(screen.getByText('Some description')).toBeInTheDocument();
  });
});

describe('CardDivider', () => {
  it('renders a divider element', () => {
    const { container } = render(<CardDivider />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<CardDivider className="my-divider" />);
    expect(container.firstChild).toHaveClass('my-divider');
  });
});

describe('CardFooter', () => {
  it('renders children', () => {
    render(<CardFooter>Footer content</CardFooter>);
    expect(screen.getByText('Footer content')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<CardFooter className="custom-footer">X</CardFooter>);
    expect(container.firstChild).toHaveClass('custom-footer');
  });
});
