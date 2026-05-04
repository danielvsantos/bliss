import { render, screen } from '@testing-library/react';
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
});
