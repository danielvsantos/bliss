import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { api } from '@/lib/api';
import {
  passiveIncomeKeys,
  usePassiveIncome,
  useIncomeStreams,
  useAssetIncomeTerms,
  useSaveAssetIncomeTerms,
  useDeleteAssetIncomeTerms,
  useSaveIncomeStream,
  useDeleteIncomeStream,
  useAttachIncomeTerms,
  useDiscardIncomeTerms,
} from './use-passive-income';

vi.mock('@/lib/api');

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  return {
    invalidate,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
};

beforeEach(() => vi.clearAllMocks());

describe('use-passive-income', () => {
  it('usePassiveIncome fetches the requested horizon', async () => {
    vi.mocked(api.getPassiveIncome).mockResolvedValue({ horizon: 24 } as never);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePassiveIncome(24), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getPassiveIncome).toHaveBeenCalledWith(24);
    expect(passiveIncomeKeys.projection(24)).toEqual(['passive-income', 'projection', 24]);
  });

  it('useIncomeStreams and useAssetIncomeTerms respect enabled', async () => {
    vi.mocked(api.getIncomeStreams).mockResolvedValue({ streams: [], eligibleCategories: [] });
    vi.mocked(api.getAssetIncomeTerms).mockResolvedValue({ asset: {}, terms: null, auto: null } as never);
    const { wrapper } = createWrapper();
    renderHook(() => useIncomeStreams(false), { wrapper });
    const { result } = renderHook(() => useAssetIncomeTerms(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.getIncomeStreams).not.toHaveBeenCalled();
    const { result: r2 } = renderHook(() => useAssetIncomeTerms(5), { wrapper });
    await waitFor(() => expect(r2.current.isSuccess).toBe(true));
    expect(api.getAssetIncomeTerms).toHaveBeenCalledWith(5);
  });

  it('mutations call the API and invalidate passive income, equity analysis and portfolio items', async () => {
    vi.mocked(api.saveAssetIncomeTerms).mockResolvedValue({ terms: {} as never, appliedTo: [1] });
    vi.mocked(api.deleteAssetIncomeTerms).mockResolvedValue(undefined);
    vi.mocked(api.createIncomeStream).mockResolvedValue({} as never);
    vi.mocked(api.updateIncomeStream).mockResolvedValue({} as never);
    vi.mocked(api.deleteIncomeStream).mockResolvedValue(undefined);
    vi.mocked(api.attachIncomeTerms).mockResolvedValue({ terms: {} as never });
    vi.mocked(api.discardIncomeTerms).mockResolvedValue(undefined);
    const { wrapper, invalidate } = createWrapper();

    const save = renderHook(() => useSaveAssetIncomeTerms(), { wrapper }).result;
    const del = renderHook(() => useDeleteAssetIncomeTerms(), { wrapper }).result;
    const saveStream = renderHook(() => useSaveIncomeStream(), { wrapper }).result;
    const delStream = renderHook(() => useDeleteIncomeStream(), { wrapper }).result;
    const attach = renderHook(() => useAttachIncomeTerms(), { wrapper }).result;
    const discard = renderHook(() => useDiscardIncomeTerms(), { wrapper }).result;

    await act(async () => {
      await save.current.mutateAsync({ assetId: 1, body: { incomeType: 'RENT', monthlyRent: 10 } });
      await del.current.mutateAsync(1);
      await saveStream.current.mutateAsync({ body: { incomeType: 'FIXED_AMOUNT' } });
      await saveStream.current.mutateAsync({ id: 4, body: { incomeType: 'FIXED_AMOUNT' } });
      await delStream.current.mutateAsync(4);
      await attach.current.mutateAsync({ id: 9, assetId: 2 });
      await discard.current.mutateAsync(9);
    });

    expect(api.saveAssetIncomeTerms).toHaveBeenCalledWith(1, { incomeType: 'RENT', monthlyRent: 10 });
    expect(api.createIncomeStream).toHaveBeenCalledTimes(1);
    expect(api.updateIncomeStream).toHaveBeenCalledWith(4, { incomeType: 'FIXED_AMOUNT' });
    expect(api.attachIncomeTerms).toHaveBeenCalledWith(9, 2);
    expect(api.discardIncomeTerms).toHaveBeenCalledWith(9);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['passive-income'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['equity-analysis'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['portfolio-items'] });
  });
});
