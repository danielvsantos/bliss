import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@/lib/api';
import React from 'react';
import { useAccountList } from './use-account-list';

vi.mock('@/lib/api');
vi.mock('@/hooks/use-page-visible', () => ({ usePageVisible: () => true }));
vi.mock('@/hooks/use-metadata', () => ({
  useMetadata: vi.fn(),
  metadataKeys: { all: ['metadata'] },
}));

import { useMetadata } from '@/hooks/use-metadata';

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

const mockMetadata = {
  accounts: [],
  banks: [],
  countries: [],
  currencies: [],
  categories: [],
};

describe('useAccountList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useMetadata).mockReturnValue({
      data: mockMetadata,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMetadata>);
    vi.mocked(api.getPlaidItems).mockResolvedValue([]);
  });

  it('returns empty accounts when metadata has no accounts', async () => {
    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.accounts).toEqual([]);
  });

  it('returns isLoading true when metadata is loading', () => {
    vi.mocked(useMetadata).mockReturnValue({
      data: undefined,
      isLoading: true,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMetadata>);
    vi.mocked(api.getPlaidItems).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    expect(result.current.isLoading).toBe(true);
  });

  it('enriches account with ACTIVE plaid item as synced/Healthy', async () => {
    const mockAccount = {
      id: 1, name: 'Checking', bankId: 10, currencyCode: 'USD',
      countryId: 'US', accountNumber: '12345678',
    };
    const mockPlaidItem = {
      id: 99, status: 'ACTIVE', historicalSyncComplete: true,
      lastSync: '2024-01-01', earliestTransactionDate: null,
      accounts: [{ id: 1 }],
    };
    vi.mocked(useMetadata).mockReturnValue({
      data: { ...mockMetadata, accounts: [mockAccount], banks: [{ id: 10, name: 'Test Bank' }] },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMetadata>);
    vi.mocked(api.getPlaidItems).mockResolvedValue([mockPlaidItem] as any);

    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    // Wait until the plaid items query resolves and enriched accounts reflect Plaid status
    await waitFor(() => expect(result.current.accounts[0]?.status).toBe('synced'));

    const acc = result.current.accounts[0];
    expect(acc.healthLabel).toBe('Healthy');
    expect(acc.healthColor).toBe('positive');
    expect(acc.institution).toBe('Test Bank');
  });

  it('enriches account with LOGIN_REQUIRED plaid item as action-required', async () => {
    const mockAccount = { id: 2, name: 'Savings', bankId: 20, currencyCode: 'USD', countryId: 'US', accountNumber: '9999' };
    const mockPlaidItem = {
      id: 100, status: 'LOGIN_REQUIRED', historicalSyncComplete: false,
      lastSync: null, earliestTransactionDate: null,
      accounts: [{ id: 2 }],
    };
    vi.mocked(useMetadata).mockReturnValue({
      data: { ...mockMetadata, accounts: [mockAccount], banks: [{ id: 20, name: 'Other Bank' }] },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMetadata>);
    vi.mocked(api.getPlaidItems).mockResolvedValue([mockPlaidItem] as any);

    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.accounts[0]?.status).toBe('action-required'));

    const acc = result.current.accounts[0];
    expect(acc.healthLabel).toBe('Action Required');
    expect(acc.healthColor).toBe('warning');
  });

  it('enriches account with REVOKED plaid item as disconnected', async () => {
    const mockAccount = { id: 3, name: 'Credit', bankId: 30, currencyCode: 'USD', countryId: 'US', accountNumber: '0000' };
    const mockPlaidItem = {
      id: 101, status: 'REVOKED', historicalSyncComplete: true,
      lastSync: null, earliestTransactionDate: null,
      accounts: [{ id: 3 }],
    };
    vi.mocked(useMetadata).mockReturnValue({
      data: { ...mockMetadata, accounts: [mockAccount], banks: [{ id: 30, name: 'Third Bank' }] },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMetadata>);
    vi.mocked(api.getPlaidItems).mockResolvedValue([mockPlaidItem] as any);

    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.accounts[0]?.status).toBe('disconnected'));

    const acc = result.current.accounts[0];
    expect(acc.healthLabel).toBe('Disconnected');
    expect(acc.healthColor).toBe('muted');
  });

  it('marks account as manual when no plaid item linked', async () => {
    const mockAccount = { id: 4, name: 'Cash', bankId: 40, currencyCode: 'EUR', countryId: 'DE', accountNumber: '' };
    vi.mocked(useMetadata).mockReturnValue({
      data: { ...mockMetadata, accounts: [mockAccount], banks: [{ id: 40, name: 'Manual Bank' }] },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMetadata>);
    vi.mocked(api.getPlaidItems).mockResolvedValue([]);

    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    const acc = result.current.accounts[0];
    expect(acc.status).toBe('manual');
    expect(acc.healthLabel).toBe('Manual');
    expect(acc.plaidItem).toBeNull();
  });

  it('masks account number correctly when long', async () => {
    const mockAccount = { id: 5, name: 'Long', bankId: 50, currencyCode: 'USD', countryId: 'US', accountNumber: '12345678' };
    vi.mocked(useMetadata).mockReturnValue({
      data: { ...mockMetadata, accounts: [mockAccount], banks: [{ id: 50, name: 'Bank' }] },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMetadata>);
    vi.mocked(api.getPlaidItems).mockResolvedValue([]);

    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));
    expect(result.current.accounts[0].mask).toBe('•••• 5678');
  });

  it('returns refetch function', async () => {
    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(typeof result.current.refetch).toBe('function');
  });

  it('returns plaidItems array', async () => {
    vi.mocked(api.getPlaidItems).mockResolvedValue([{ id: 1 }] as any);
    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.plaidItems).toHaveLength(1);
  });

  it('sets healthColor to destructive for ERROR status plaid item', async () => {
    const mockAccount = { id: 6, name: 'Err', bankId: 60, currencyCode: 'USD', countryId: 'US', accountNumber: '1111' };
    const mockPlaidItem = {
      id: 102, status: 'ERROR', historicalSyncComplete: false,
      lastSync: null, earliestTransactionDate: null,
      accounts: [{ id: 6 }],
    };
    vi.mocked(useMetadata).mockReturnValue({
      data: { ...mockMetadata, accounts: [mockAccount], banks: [{ id: 60, name: 'Err Bank' }] },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMetadata>);
    vi.mocked(api.getPlaidItems).mockResolvedValue([mockPlaidItem] as any);

    const { result } = renderHook(() => useAccountList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.accounts[0]?.healthColor).toBe('destructive'));
  });
});
