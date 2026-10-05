import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { NotificationCenter } from './notification-center';
import { useNotificationSummary, useMarkNotificationsSeen } from '@/hooks/use-notifications';
import { mockQueryResult, mockMutationResult } from '@/test/mock-helpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/hooks/use-notifications');

const mockUseNotificationSummary = vi.mocked(useNotificationSummary);
const mockUseMarkNotificationsSeen = vi.mocked(useMarkNotificationsSeen);

const mockMutate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockUseMarkNotificationsSeen.mockReturnValue(mockMutationResult({ mutate: mockMutate }));
});

const renderCenter = () =>
  render(<MemoryRouter><NotificationCenter /></MemoryRouter>);

describe('NotificationCenter', () => {
  it('renders the bell button', () => {
    mockUseNotificationSummary.mockReturnValue(
      mockQueryResult({ totalUnseen: 0, signals: [] })
    );
    const { container } = renderCenter();
    expect(container.querySelector('button')).toBeInTheDocument();
  });

  it('does not show notification dot when no unseen', () => {
    mockUseNotificationSummary.mockReturnValue(
      mockQueryResult({ totalUnseen: 0, signals: [] })
    );
    const { container } = renderCenter();
    const dotSpan = container.querySelector('span[style*="border-radius: 50%"]');
    expect(dotSpan).not.toBeInTheDocument();
  });

  it('shows notification dot when unseen > 0', () => {
    mockUseNotificationSummary.mockReturnValue(
      mockQueryResult({ totalUnseen: 3, signals: [] })
    );
    const { container } = renderCenter();
    const dotSpan = container.querySelector('span[style*="border-radius: 50%"]');
    expect(dotSpan).toBeInTheDocument();
  });

  it('handles undefined data gracefully', () => {
    mockUseNotificationSummary.mockReturnValue(mockQueryResult(undefined));
    const { container } = renderCenter();
    expect(container.querySelector('button')).toBeInTheDocument();
  });

  describe('PROCESSING_FAILED (#100, AC8)', () => {
    const signal = (href: string | null) => ({
      type: 'PROCESSING_FAILED', count: 2, severity: 'warning', label: '2 background updates failed', href, isNew: true,
    });

    it('links admins to Settings → Processing', () => {
      mockUseNotificationSummary.mockReturnValue(
        mockQueryResult({ totalUnseen: 2, lastSeenAt: null, signals: [signal('/settings?tab=processing')] }),
      );
      renderCenter();
      fireEvent.click(screen.getAllByRole('button')[0]);
      const row = screen.getByTestId('signal-PROCESSING_FAILED');
      expect(row.tagName).toBe('BUTTON');
      expect(row).toHaveTextContent('activity.notification.failed');
    });

    it('is a plain label for other roles (no link)', () => {
      mockUseNotificationSummary.mockReturnValue(
        mockQueryResult({ totalUnseen: 2, lastSeenAt: null, signals: [signal(null)] }),
      );
      renderCenter();
      fireEvent.click(screen.getAllByRole('button')[0]);
      const row = screen.getByTestId('signal-PROCESSING_FAILED');
      expect(row.tagName).toBe('DIV');
      expect(row).toHaveTextContent('activity.notification.failed');
    });
  });
});
