import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CapybaraIllustration } from './capybara';

describe('CapybaraIllustration', () => {
  it('renders the capybara SVG', () => {
    const { container } = render(<CapybaraIllustration />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders the aria-label on the SVG', () => {
    render(<CapybaraIllustration />);
    expect(screen.getByLabelText('Bliss mascot capybara illustration')).toBeInTheDocument();
  });

  it('shows default caption text', () => {
    render(<CapybaraIllustration showCaption />);
    expect(screen.getByText('All calm, nothing here.')).toBeInTheDocument();
  });

  it('shows default subcaption text', () => {
    render(<CapybaraIllustration showCaption />);
    expect(screen.getByText('Navigate from the sidebar to explore your bliss dashboard.')).toBeInTheDocument();
  });

  it('hides caption when showCaption=false', () => {
    render(<CapybaraIllustration showCaption={false} />);
    expect(screen.queryByText('All calm, nothing here.')).not.toBeInTheDocument();
  });

  it('renders custom caption', () => {
    render(<CapybaraIllustration showCaption caption="No results found" />);
    expect(screen.getByText('No results found')).toBeInTheDocument();
  });

  it('renders custom subcaption', () => {
    render(<CapybaraIllustration showCaption subcaption="Try adjusting your filters." />);
    expect(screen.getByText('Try adjusting your filters.')).toBeInTheDocument();
  });

  it('accepts custom width', () => {
    const { container } = render(<CapybaraIllustration width={200} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '200');
  });

  it('applies custom className', () => {
    const { container } = render(<CapybaraIllustration className="my-custom-class" />);
    expect(container.firstChild).toHaveClass('my-custom-class');
  });
});
