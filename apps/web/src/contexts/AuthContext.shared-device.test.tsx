/**
 * #78 R4 acceptance: user A's data cached in this browser, A's session expired
 * (or the tab was closed without signing out), user B signs in. None of A's
 * accounts, holdings, metadata or tenantMeta may render or remain in
 * localStorage. The QueryClient and tenantMeta storage are the real ones.
 */
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/api';
import type { User } from '@/types/api';
import { AuthProvider } from './AuthContext';
import { useAuth } from '@/hooks/use-auth';
import { queryClient, clearPersistedQueryCache, PERSIST_KEY, CACHE_OWNER_KEY } from '@/lib/query-client';

vi.mock('@/lib/api', () => ({
  resetSessionExpired: vi.fn(),
  default: { getSession: vi.fn(), signin: vi.fn(), signout: vi.fn(), signup: vi.fn() },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/utils/tenantMetaStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/tenantMetaStorage')>();
  return {
    ...actual,
    // The real one fetches the tenant; here B's tenantMeta is simply written.
    updateTenantMetaFromAPI: vi.fn(async (tenantId: string) => {
      window.localStorage.setItem('tenantMeta', JSON.stringify({ id: tenantId, banks: [{ id: 'b-bank' }] }));
    }),
  };
});

const USER_A = { id: 'user-a', email: 'a@x.co', tenant: { id: 'tenant-a' } } as unknown as User;
const USER_B = { id: 'user-b', email: 'b@x.co', tenant: { id: 'tenant-b' } } as unknown as User;

function seedUserACache() {
  const query = (key: unknown[], data: unknown) => ({
    queryKey: key,
    queryHash: JSON.stringify(key),
    state: {
      data, dataUpdateCount: 1, dataUpdatedAt: Date.now(), error: null, errorUpdateCount: 0, errorUpdatedAt: 0,
      fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null, isInvalidated: false, status: 'success', fetchStatus: 'idle',
    },
  });
  window.localStorage.setItem(PERSIST_KEY, JSON.stringify({
    timestamp: Date.now(),
    buster: '',
    clientState: {
      mutations: [],
      queries: [
        query(['accounts'], { accounts: [{ id: 1, name: "A's checking" }] }),
        query(['metadata'], { countries: ['ES'] }),
        query(['portfolio-holdings', {}], [{ ticker: 'A-HOLDING' }]),
      ],
    },
  }));
  window.localStorage.setItem('tenantMeta', JSON.stringify({ id: 'tenant-a', banks: [{ id: 'a-bank' }] }));
  window.localStorage.setItem(CACHE_OWNER_KEY, 'user-a:tenant-a');
}

const wrapper = ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPersistedQueryCache();
  window.localStorage.clear();
});

describe('shared device (#78 R4)', () => {
  it("B signing in after A's session lapsed sees none of A's data", async () => {
    seedUserACache();
    vi.mocked(api.getSession).mockResolvedValueOnce({ user: USER_B });

    // Record what was in the cache at the moment the app first saw a user.
    const seenWithUser: unknown[] = [];
    const { result } = renderHook(() => {
      const auth = useAuth();
      if (auth.user) seenWithUser.push(queryClient.getQueryData(['accounts']));
      return auth;
    }, { wrapper });

    await waitFor(() => expect(result.current.user).toEqual(USER_B));

    expect(seenWithUser.every((d) => d === undefined)).toBe(true);
    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
    expect(queryClient.getQueryData(['metadata'])).toBeUndefined();
    expect(queryClient.getQueryData(['portfolio-holdings', {}])).toBeUndefined();
    const stored = JSON.stringify({ ...window.localStorage });
    expect(stored).not.toContain("A's checking");
    expect(stored).not.toContain('A-HOLDING');
    expect(stored).not.toContain('a-bank');
    expect(stored).not.toContain('tenant-a');
    expect(window.localStorage.getItem(CACHE_OWNER_KEY)).toBe('user-b:tenant-b');
  });

  it('A coming back to their own browser still gets the instant paint', async () => {
    seedUserACache();
    vi.mocked(api.getSession).mockResolvedValueOnce({ user: USER_A });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(USER_A));

    expect(queryClient.getQueryData(['accounts'])).toEqual({ accounts: [{ id: 1, name: "A's checking" }] });
  });

  it("an expired session leaves nothing of A's behind", async () => {
    seedUserACache();
    vi.mocked(api.getSession).mockResolvedValueOnce({ user: USER_A });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(USER_A));

    act(() => {
      window.dispatchEvent(new Event('auth:session-expired'));
    });

    expect(result.current.user).toBeNull();
    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
    expect(window.localStorage.getItem('tenantMeta')).toBeNull();
    expect(window.localStorage.getItem(CACHE_OWNER_KEY)).toBeNull();
  });
});
