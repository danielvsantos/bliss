import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncLogsTable } from './sync-logs-table';
import { useSyncLogs } from '@/hooks/use-sync-logs';
import { mockQueryResult, mockQueryLoading } from '@/test/mock-helpers';

vi.mock('@/hooks/use-sync-logs');

const mockUseSyncLogs = vi.mocked(useSyncLogs);

beforeEach(() => vi.clearAllMocks());

const makeLogs = () => [
  { id: '1', createdAt: '2025-01-15T10:00:00Z', type: 'INITIAL_SYNC', status: 'SUCCESS' },
  { id: '2', createdAt: '2025-01-14T08:30:00Z', type: 'SYNC_UPDATE', status: 'FAILED' },
];

describe('SyncLogsTable', () => {
  it('renders nothing when plaidItemId is null', () => {
    mockUseSyncLogs.mockReturnValue(mockQueryResult([]));
    const { container } = render(<SyncLogsTable plaidItemId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows loading skeleton when loading', () => {
    mockUseSyncLogs.mockReturnValue(mockQueryLoading());
    const { container } = render(<SyncLogsTable plaidItemId="item-1" />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows empty state when no logs', () => {
    mockUseSyncLogs.mockReturnValue(mockQueryResult([]));
    render(<SyncLogsTable plaidItemId="item-1" />);
    expect(screen.getByText('No sync logs yet.')).toBeInTheDocument();
  });

  it('renders sync log rows', () => {
    mockUseSyncLogs.mockReturnValue(mockQueryResult(makeLogs()));
    render(<SyncLogsTable plaidItemId="item-1" />);
    expect(screen.getByText('Initial Sync')).toBeInTheDocument();
    expect(screen.getByText('Sync Update')).toBeInTheDocument();
  });

  it('renders SUCCESS badge', () => {
    mockUseSyncLogs.mockReturnValue(mockQueryResult(makeLogs()));
    render(<SyncLogsTable plaidItemId="item-1" />);
    expect(screen.getByText('Success')).toBeInTheDocument();
  });

  it('renders Failed badge for non-SUCCESS status', () => {
    mockUseSyncLogs.mockReturnValue(mockQueryResult(makeLogs()));
    render(<SyncLogsTable plaidItemId="item-1" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders table headers', () => {
    mockUseSyncLogs.mockReturnValue(mockQueryResult(makeLogs()));
    render(<SyncLogsTable plaidItemId="item-1" />);
    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('renders section title "Recent Sync Logs"', () => {
    mockUseSyncLogs.mockReturnValue(mockQueryResult([]));
    render(<SyncLogsTable plaidItemId="item-1" />);
    expect(screen.getByText('Recent Sync Logs')).toBeInTheDocument();
  });
});
