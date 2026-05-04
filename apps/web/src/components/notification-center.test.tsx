import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { NotificationCenter } from './notification-center';
import { useNotificationSummary, useMarkNotificationsSeen } from '@/hooks/use-notifications';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-notifications');

const mockUseNotificationSummary = vi.mocked(useNotificationSummary);
const mockUseMarkNotificationsSeen = vi.mocked(useMarkNotificationsSeen);

const mockMutate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockUseMarkNotificationsSeen.mockReturnValue({ mutate: mockMutate } as any);
});

const renderCenter = () =>
  render(<MemoryRouter><NotificationCenter /></MemoryRouter>);

describe('NotificationCenter', () => {
  it('renders the bell button', () => {
    mockUseNotificationSummary.mockReturnValue({
      data: { totalUnseen: 0, signals: [] },
    } as any);
    const { container } = renderCenter();
    // Bell icon wraps in a button
    expect(container.querySelector('button')).toBeInTheDocument();
  });

  it('does not show notification dot when no unseen', () => {
    mockUseNotificationSummary.mockReturnValue({
      data: { totalUnseen: 0, signals: [] },
    } as any);
    const { container } = renderCenter();
    // The red dot is an inline-style span -- check it's not present
    const dotSpan = container.querySelector('span[style*="border-radius: 50%"]');
    expect(dotSpan).not.toBeInTheDocument();
  });

  it('shows notification dot when unseen > 0', () => {
    mockUseNotificationSummary.mockReturnValue({
      data: { totalUnseen: 3, signals: [] },
    } as any);
    const { container } = renderCenter();
    const dotSpan = container.querySelector('span[style*="border-radius: 50%"]');
    expect(dotSpan).toBeInTheDocument();
  });

  it('handles undefined data gracefully', () => {
    mockUseNotificationSummary.mockReturnValue({
      data: undefined,
    } as any);
    const { container } = renderCenter();
    expect(container.querySelector('button')).toBeInTheDocument();
  });
});
