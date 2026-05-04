import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Avatar, AvatarImage, AvatarFallback } from './avatar';

describe('Avatar components', () => {
  it('renders Avatar root with data-slot', () => {
    render(<Avatar data-testid="avatar"><AvatarFallback>AB</AvatarFallback></Avatar>);
    expect(screen.getByTestId('avatar')).toHaveAttribute('data-slot', 'avatar');
  });

  it('renders AvatarFallback with initials', () => {
    render(
      <Avatar>
        <AvatarFallback data-testid="fallback">JD</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId('fallback')).toHaveAttribute('data-slot', 'avatar-fallback');
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('renders AvatarImage element in the DOM', () => {
    // Radix AvatarImage hides itself when the image hasn't loaded (jsdom doesn't load images).
    // Confirm AvatarFallback shows as a result.
    render(
      <Avatar>
        <AvatarImage src="https://example.com/photo.jpg" alt="User photo" />
        <AvatarFallback data-testid="fallback">U</AvatarFallback>
      </Avatar>
    );
    // Fallback is visible when image hasn't loaded
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
  });

  it('applies custom className to Avatar', () => {
    render(
      <Avatar className="size-16" data-testid="avatar">
        <AvatarFallback>XL</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId('avatar')).toHaveClass('size-16');
  });

  it('renders multiple avatar sizes', () => {
    render(
      <div>
        <Avatar data-testid="sm"><AvatarFallback>S</AvatarFallback></Avatar>
        <Avatar data-testid="lg" className="size-16"><AvatarFallback>L</AvatarFallback></Avatar>
      </div>
    );
    expect(screen.getByTestId('sm')).toBeInTheDocument();
    expect(screen.getByTestId('lg')).toBeInTheDocument();
  });

  it('AvatarFallback applies custom className', () => {
    render(
      <Avatar>
        <AvatarFallback className="bg-blue-500" data-testid="fallback">BC</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId('fallback')).toHaveClass('bg-blue-500');
  });
});
