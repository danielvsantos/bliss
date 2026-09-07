import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/use-metadata', () => ({
  useAccounts: vi.fn(),
}));

import { useAccounts } from '@/hooks/use-metadata';
import { useSelectableAccounts } from './use-selectable-accounts';

const draft = { id: 1, name: 'Chase', bankId: 1, currencyCode: 'USD', countryId: 'US', accountNumber: 'chase-acc-1', owners: [], isDraft: true };
const real = { id: 2, name: 'Ally', bankId: 2, currencyCode: 'USD', countryId: 'US', accountNumber: '12345678', owners: [], isDraft: false };
const legacy = { id: 3, name: 'Old', bankId: 3, currencyCode: 'USD', countryId: 'US', accountNumber: '87654321', owners: [] }; // isDraft undefined

describe('useSelectableAccounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('filters out draft accounts, keeps real and legacy (undefined isDraft) ones', () => {
    vi.mocked(useAccounts).mockReturnValue({
      data: [draft, real, legacy],
      isLoading: false,
    } as unknown as ReturnType<typeof useAccounts>);

    const { result } = renderHook(() => useSelectableAccounts());

    expect(result.current.data?.map((a) => a.id)).toEqual([2, 3]);
  });

  it('passes through loading state and returns undefined data while loading', () => {
    vi.mocked(useAccounts).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useAccounts>);

    const { result } = renderHook(() => useSelectableAccounts());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });
});
