import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Dialog } from './dialog';

describe('Dialog (custom)', () => {
  it('renders nothing when isOpen=false', () => {
    render(<Dialog isOpen={false} onClose={vi.fn()}>Content</Dialog>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders dialog when isOpen=true', () => {
    render(<Dialog isOpen onClose={vi.fn()}>Dialog Content</Dialog>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders children inside dialog', () => {
    render(<Dialog isOpen onClose={vi.fn()}>Hello World</Dialog>);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(<Dialog isOpen onClose={onClose}>Content</Dialog>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call onClose for non-Escape keys', () => {
    const onClose = vi.fn();
    render(<Dialog isOpen onClose={onClose}>Content</Dialog>);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('has aria-modal="true" on dialog element', () => {
    render(<Dialog isOpen onClose={vi.fn()}>Content</Dialog>);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('locks body scroll when open', () => {
    render(<Dialog isOpen onClose={vi.fn()}>Content</Dialog>);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores body scroll on unmount', () => {
    const { unmount } = render(<Dialog isOpen onClose={vi.fn()}>Content</Dialog>);
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('accepts custom maxWidth', () => {
    render(<Dialog isOpen onClose={vi.fn()} maxWidth={600}>Wide Content</Dialog>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
