import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Avatar, AvatarGroup } from './avatar';

describe('Avatar', () => {
  it('renders initials from name', () => {
    render(<Avatar name="John Doe" />);
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('renders single initial for single-word name', () => {
    render(<Avatar name="Alice" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('truncates initials to 2 chars', () => {
    render(<Avatar name="John Michael Doe" />);
    // Only first 2 initials
    expect(screen.getByText('JM')).toBeInTheDocument();
  });

  it('renders aria-label with name', () => {
    render(<Avatar name="Sam Smith" />);
    expect(screen.getByLabelText('User profile: Sam Smith')).toBeInTheDocument();
  });

  it('shows status dot when status is provided', () => {
    render(<Avatar name="Jane" status="online" />);
    expect(screen.getByLabelText('online')).toBeInTheDocument();
  });

  it('does not show status dot when no status', () => {
    render(<Avatar name="Jane" />);
    expect(screen.queryByLabelText('online')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('offline')).not.toBeInTheDocument();
  });

  it('renders all status types', () => {
    for (const status of ['online', 'away', 'busy', 'offline'] as const) {
      const { unmount } = render(<Avatar name="User" status={status} />);
      expect(screen.getByLabelText(status)).toBeInTheDocument();
      unmount();
    }
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Avatar name="Test User" onClick={onClick} />);
    await user.click(screen.getByLabelText('User profile: Test User'));
    expect(onClick).toHaveBeenCalled();
  });

  it('applies custom className', () => {
    const { container } = render(<Avatar name="U" className="custom-cls" />);
    expect(container.firstChild).toHaveClass('custom-cls');
  });

  it('renders all size variants', () => {
    for (const size of ['xs', 'sm', 'md', 'lg', 'xl'] as const) {
      const { unmount } = render(<Avatar name="User" size={size} />);
      expect(screen.getByText('U')).toBeInTheDocument();
      unmount();
    }
  });

  it('renders default name when no name provided', () => {
    render(<Avatar />);
    // Default is "Alex Morgan" -> "AM"
    expect(screen.getByText('AM')).toBeInTheDocument();
  });
});

describe('AvatarGroup', () => {
  it('renders visible avatars up to max', () => {
    render(<AvatarGroup names={['Alice Jones', 'Bob Smith', 'Charlie Brown']} max={2} />);
    expect(screen.getByText('AJ')).toBeInTheDocument();
    expect(screen.getByText('BS')).toBeInTheDocument();
  });

  it('shows overflow count when names exceed max', () => {
    render(<AvatarGroup names={['Alice Jones', 'Bob Smith', 'Charlie Brown', 'Dan White']} max={2} />);
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('does not show overflow when names fit within max', () => {
    render(<AvatarGroup names={['Alice', 'Bob']} max={4} />);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('renders all avatars when max is large', () => {
    render(<AvatarGroup names={['Alice Jones', 'Bob Smith']} max={10} />);
    expect(screen.getByText('AJ')).toBeInTheDocument();
    expect(screen.getByText('BS')).toBeInTheDocument();
  });
});
