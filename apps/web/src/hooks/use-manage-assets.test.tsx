import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { api } from '@/lib/api';
import {
  manageAssetsKeys,
  normalizeFilters,
  useAssetClassInfo,
  useDebtTerms,
  useManageAssets,
  useManagedAsset,
  PAGE_SIZE,
} from './use-manage-assets';
import type { ManageAssetsResponse, ManagedAsset } from '@/types/manage-assets';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

const row = (id: number) => ({ id, symbol: `S${id}` }) as unknown as ManagedAsset;
const response = (items: ManagedAsset[], nextCursor: string | null = null) =>
  ({ portfolioCurrency: 'USD', items, nextCursor, totals: { count: items.length }, detachedTermsCount: 0 }) as ManageAssetsResponse;

beforeEach(() => vi.clearAllMocks());

describe('normalizeFilters', () => {
  it('drops empty values so equivalent filters share a cache entry', () => {
    expect(normalizeFilters({ search: '  ', type: '', includeClosed: false })).toEqual({});
    expect(normalizeFilters({ search: ' ko ', accountId: 0, status: 'stale', includeClosed: true, assetClass: 'REIT', type: 'Stocks' }))
      .toEqual({ search: 'ko', accountId: 0, status: 'stale', includeClosed: true, assetClass: 'REIT', type: 'Stocks' });
    expect(manageAssetsKeys.list(normalizeFilters({ search: '' }))).toEqual(['portfolio-assets', 'list', {}]);
    // `attention` is the server default, so only `name` is sent.
    expect(normalizeFilters({ sort: 'attention' })).toEqual({});
    expect(normalizeFilters({ sort: 'name' })).toEqual({ sort: 'name' });
  });
});

describe('useManageAssets', () => {
  it('fetches the first page, then the next one with its cursor', async () => {
    vi.mocked(api.getManageAssets)
      .mockResolvedValueOnce(response([row(1)], 'MQ=='))
      .mockResolvedValueOnce(response([row(2)]));
    const { result } = renderHook(() => useManageAssets({ search: 'x' }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getManageAssets).toHaveBeenCalledWith({ search: 'x', cursor: null, limit: PAGE_SIZE });
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => { await result.current.fetchNextPage(); });
    expect(api.getManageAssets).toHaveBeenLastCalledWith({ search: 'x', cursor: 'MQ==', limit: PAGE_SIZE });
    await waitFor(() => expect(result.current.data?.pages.flatMap((p) => p.items).map((r) => r.id)).toEqual([1, 2]));
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('useManagedAsset', () => {
  it('uses the loaded row without a request', () => {
    const { result } = renderHook(() => useManagedAsset(2, [row(1), row(2)]), { wrapper: createWrapper() });
    expect(result.current.asset?.id).toBe(2);
    expect(api.getManageAssets).not.toHaveBeenCalled();
  });

  it('fetches a row that is not loaded', async () => {
    vi.mocked(api.getManageAssets).mockResolvedValue(response([row(9)]));
    const { result } = renderHook(() => useManagedAsset(9, [row(1)]), { wrapper: createWrapper() });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.asset?.id).toBe(9));
    expect(api.getManageAssets).toHaveBeenCalledWith({ id: 9, includeClosed: true });
  });

  it('reports a missing row', async () => {
    vi.mocked(api.getManageAssets).mockResolvedValue(response([]));
    const { result } = renderHook(() => useManagedAsset(9, []), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.asset).toBeNull();
  });

  it('does nothing without an id', () => {
    const { result } = renderHook(() => useManagedAsset(null, undefined), { wrapper: createWrapper() });
    expect(result.current).toEqual({ asset: null, isLoading: false, notFound: false });
    expect(api.getManageAssets).not.toHaveBeenCalled();
  });
});

describe('modal data hooks', () => {
  it('useDebtTerms loads terms, and stays idle without an id', async () => {
    vi.mocked(api.getDebtTerms).mockResolvedValue(null);
    const { result } = renderHook(() => useDebtTerms(4), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(api.getDebtTerms).toHaveBeenCalledWith(4);

    renderHook(() => useDebtTerms(null), { wrapper: createWrapper() });
    expect(api.getDebtTerms).toHaveBeenCalledTimes(1);
  });

  it('useAssetClassInfo loads the classification', async () => {
    vi.mocked(api.getAssetClass).mockResolvedValue({ assetClass: 'REIT', assetClassSource: 'AUTO', autoAssetClass: 'REIT' });
    const { result } = renderHook(() => useAssetClassInfo(5), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data?.assetClass).toBe('REIT'));
    expect(api.getAssetClass).toHaveBeenCalledWith(5);
  });
});
