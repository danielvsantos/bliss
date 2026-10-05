import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataUpdatingBanner } from './DataUpdatingBanner';
import { useActivityWatcher, type WatchedActivity } from '@/hooks/use-activity';
import type { ActivityInFlightEntry } from '@/types/activity';

/** Page-level "data is updating" banner (#100, PRD R5 / AC3). The refetch-on-settle logic is covered in use-activity.test. */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.progress != null ? `${k}:${o.progress}` : k) }),
}));
vi.mock('@/hooks/use-activity', () => ({ useActivityWatcher: vi.fn() }));

const view = (over: Partial<WatchedActivity> = {}): WatchedActivity => ({
  busy: false, state: null, primaryEntry: null, failed: null, lastUpdatedAt: null, available: true, ...over,
});

const entry: ActivityInFlightEntry = {
  id: 'analytics:1', type: 'ANALYTICS_UPDATE', stage: 'updating_analytics', state: 'running', progress: 40,
  trigger: 'user_change', affects: ['ANALYTICS_UPDATE'], enqueuedAt: null, startedAt: null, updatedAt: null,
};

beforeEach(() => vi.clearAllMocks());

describe('DataUpdatingBanner', () => {
  it('passes the watch list, query keys and primary type to the watcher', () => {
    vi.mocked(useActivityWatcher).mockReturnValue(view());
    render(<DataUpdatingBanner watch={['PORTFOLIO_UPDATE', 'SECURITY_DATA']} invalidate={[['portfolio-holdings']]} />);
    expect(useActivityWatcher).toHaveBeenCalledWith(['PORTFOLIO_UPDATE', 'SECURITY_DATA'], [['portfolio-holdings']], 'PORTFOLIO_UPDATE');
  });

  it('shows the running banner with stage and progress', () => {
    vi.mocked(useActivityWatcher).mockReturnValue(view({ busy: true, state: 'running', primaryEntry: entry }));
    render(<DataUpdatingBanner watch={['ANALYTICS_UPDATE']} invalidate={[]} />);
    const banner = screen.getByTestId('data-updating-banner');
    expect(banner).toHaveAttribute('data-variant', 'running');
    expect(banner).toHaveTextContent('activity.banner.runningProgress:40');
    expect(banner.className).toContain('bg-warning/10');
  });

  it.each([
    ['queued', 'activity.banner.queued', 'bg-warning/10'],
    ['stalled', 'activity.banner.stalled', 'bg-warning/10'],
    ['failed', 'activity.banner.failed', 'bg-destructive/10'],
  ] as const)('%s variant', (state, text, token) => {
    vi.mocked(useActivityWatcher).mockReturnValue(view({
      busy: state !== 'failed', state, primaryEntry: state === 'failed' ? null : { ...entry, state: state === 'stalled' ? 'stalled' : 'queued', progress: null },
      failed: state === 'failed' ? { type: 'ANALYTICS_UPDATE', errorCode: 'P2034' } : null,
    }));
    render(<DataUpdatingBanner watch={['ANALYTICS_UPDATE']} invalidate={[]} />);
    const banner = screen.getByTestId('data-updating-banner');
    expect(banner).toHaveTextContent(text);
    expect(banner.className).toContain(token);
  });

  it('idle: a quiet "Updated X ago" from the primary type', () => {
    vi.mocked(useActivityWatcher).mockReturnValue(view({ lastUpdatedAt: new Date(Date.now() - 120_000).toISOString() }));
    render(<DataUpdatingBanner watch={['ANALYTICS_UPDATE']} invalidate={[]} />);
    expect(screen.queryByTestId('data-updating-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('data-updated-at')).toHaveTextContent('activity.banner.updated');
  });

  it('renders nothing when idle with no stamp, or when status is unavailable', () => {
    vi.mocked(useActivityWatcher).mockReturnValue(view());
    const { container, rerender } = render(<DataUpdatingBanner watch={['ANALYTICS_UPDATE']} invalidate={[]} />);
    expect(container).toBeEmptyDOMElement();
    vi.mocked(useActivityWatcher).mockReturnValue(view({ available: false, busy: true, state: 'running' }));
    rerender(<DataUpdatingBanner watch={['ANALYTICS_UPDATE']} invalidate={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
