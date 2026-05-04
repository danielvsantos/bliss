import { render, screen, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Toaster } from './toaster';
import { toast } from '@/hooks/use-toast';

describe('Toaster', () => {
  it('renders without crashing', () => {
    const { container } = render(<Toaster />);
    expect(container).toBeTruthy();
  });

  it('shows a toast when toast() is called', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Test notification', description: 'Something happened' });
    });
    expect(screen.getByText('Test notification')).toBeInTheDocument();
    expect(screen.getByText('Something happened')).toBeInTheDocument();
  });

  it('shows toast with only a title', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Title only' });
    });
    expect(screen.getByText('Title only')).toBeInTheDocument();
  });

  it('shows toast with only a description', async () => {
    render(<Toaster />);
    act(() => {
      toast({ description: 'Description only' });
    });
    expect(screen.getByText('Description only')).toBeInTheDocument();
  });
});
