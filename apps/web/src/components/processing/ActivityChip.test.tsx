import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityChip } from './ActivityChip';
import { useActivityStatus, type ActivityStatus, type ActivityRow } from '@/hooks/use-activity';

/** Header processing-status chip (#100, PRD R4): states, coalesced popover rows, design tokens. */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('@/hooks/use-activity', () => ({ useActivityStatus: vi.fn() }));

const status = (over: Partial<ActivityStatus> = {}): ActivityStatus => ({
  data: undefined,
  available: true,
  rows: [],
  chipState: 'hidden',
  lastUpdatedAt: null,
  workerOffline: false,
  ...over,
});

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  type: 'PORTFOLIO_UPDATE', state: 'running', stage: 'valuing_assets', progress: 40, count: 1, trigger: 'user_change', ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('ActivityChip', () => {
  it('renders nothing when everything is up to date (PRD OQ1)', () => {
    vi.mocked(useActivityStatus).mockReturnValue(status());
    const { container } = render(<ActivityChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows "Queued" right after a write, before the first poll (AC1)', () => {
    vi.mocked(useActivityStatus).mockReturnValue(status({
      chipState: 'queued', rows: [row({ state: 'queued', stage: null, progress: null, trigger: null, optimistic: true })],
    }));
    render(<ActivityChip />);
    const chip = screen.getByTestId('activity-chip');
    expect(chip).toHaveAttribute('data-state', 'queued');
    expect(chip).toHaveTextContent('activity.chip.queued');
  });

  it.each([
    ['running', 'activity.chip.running', 'text-warning'],
    ['stalled', 'activity.chip.stalled', 'text-warning'],
    ['failed', 'activity.chip.failed', 'text-destructive'],
  ] as const)('%s uses its label and only design tokens', (state, label, token) => {
    vi.mocked(useActivityStatus).mockReturnValue(status({ chipState: state, rows: [row({ state })] }));
    render(<ActivityChip />);
    const chip = screen.getByTestId('activity-chip');
    expect(chip).toHaveTextContent(label);
    expect(chip.className).toContain(token);
    expect(chip.className).not.toMatch(/(green|red|amber|blue|yellow|orange)-\d00/);
  });

  it('lists one row per activity type with stage, progress, count and trigger (AC2, AC5)', () => {
    vi.mocked(useActivityStatus).mockReturnValue(status({
      chipState: 'running',
      rows: [
        row({ count: 10, trigger: 'agent' }),
        row({ type: 'ANALYTICS_UPDATE', state: 'queued', stage: 'updating_analytics', progress: null, trigger: 'nightly' }),
      ],
      lastUpdatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    }));
    render(<ActivityChip />);
    fireEvent.click(screen.getByTestId('activity-chip'));

    const portfolio = screen.getByTestId('activity-row-PORTFOLIO_UPDATE');
    expect(portfolio).toHaveTextContent('activity.stages.valuing_assets');
    expect(portfolio).toHaveTextContent('40%');
    expect(portfolio).toHaveTextContent('activity.chip.jobs');
    expect(portfolio).toHaveTextContent('activity.triggers.agent');
    expect(screen.getByTestId('activity-row-ANALYTICS_UPDATE')).toHaveTextContent('activity.triggers.nightly');
    expect(screen.getAllByTestId(/^activity-row-/)).toHaveLength(2);
    expect(screen.getByText('activity.chip.lastUpdated')).toBeInTheDocument();
  });

  it('shows the error code of a failure and a worker-offline notice', () => {
    vi.mocked(useActivityStatus).mockReturnValue(status({
      chipState: 'failed', workerOffline: true, rows: [row({ state: 'failed', errorCode: 'P2034', progress: null })],
    }));
    render(<ActivityChip />);
    fireEvent.click(screen.getByTestId('activity-chip'));
    expect(screen.getByText('activity.chip.failedHint')).toBeInTheDocument();
    expect(screen.getByText('activity.chip.workerOffline')).toBeInTheDocument();
  });
});
