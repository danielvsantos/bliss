import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ConfidenceDisplay } from './confidence-display';

describe('ConfidenceDisplay', () => {
  it('renders dash when confidence is null', () => {
    render(<ConfidenceDisplay confidence={null} />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('renders dash when confidence is undefined', () => {
    render(<ConfidenceDisplay confidence={undefined} />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('renders percentage for 0.95 → 95%', () => {
    render(<ConfidenceDisplay confidence={0.95} />);
    expect(screen.getByText('95%')).toBeInTheDocument();
  });

  it('renders positive color for >= 80%', () => {
    render(<ConfidenceDisplay confidence={0.85} />);
    expect(screen.getByText('85%')).toHaveClass('text-positive');
  });

  it('renders warning color for 50-79%', () => {
    render(<ConfidenceDisplay confidence={0.65} />);
    expect(screen.getByText('65%')).toHaveClass('text-warning');
  });

  it('renders destructive color for < 50%', () => {
    render(<ConfidenceDisplay confidence={0.3} />);
    expect(screen.getByText('30%')).toHaveClass('text-destructive');
  });

  it('rounds to nearest integer', () => {
    render(<ConfidenceDisplay confidence={0.876} />);
    expect(screen.getByText('88%')).toBeInTheDocument();
  });

  it('renders 0%', () => {
    render(<ConfidenceDisplay confidence={0} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
