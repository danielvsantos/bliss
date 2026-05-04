import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { NetWorthSparkline } from './net-worth-sparkline';

describe('NetWorthSparkline', () => {
  it('renders nothing with fewer than 2 data points', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[100]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing with empty data points', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an SVG with 2+ data points', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[100, 200]} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders a polyline element', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[100, 150, 200]} />);
    expect(container.querySelector('polyline')).toBeInTheDocument();
  });

  it('renders a path element for the area fill', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[100, 150, 200]} />);
    expect(container.querySelector('path')).toBeInTheDocument();
  });

  it('is aria-hidden', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[100, 200]} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('applies positive color when last > first', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[100, 200]} />);
    const polyline = container.querySelector('polyline');
    expect(polyline?.getAttribute('stroke')).toContain('positive');
  });

  it('applies negative color when last < first', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[200, 100]} />);
    const polyline = container.querySelector('polyline');
    expect(polyline?.getAttribute('stroke')).toContain('negative');
  });

  it('handles flat data (last === first)', () => {
    const { container } = render(<NetWorthSparkline dataPoints={[100, 100, 100]} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('applies custom className to the wrapper', () => {
    const { container } = render(
      <NetWorthSparkline dataPoints={[100, 200]} className="my-sparkline" />
    );
    expect(container.firstChild).toHaveClass('my-sparkline');
  });

  it('renders with many data points', () => {
    const points = [100, 120, 80, 150, 200, 90, 300];
    const { container } = render(<NetWorthSparkline dataPoints={points} />);
    expect(container.querySelector('polyline')).toBeInTheDocument();
  });
});
