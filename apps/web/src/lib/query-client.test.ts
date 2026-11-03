import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  queryClient,
  clearPersistedQueryCache,
  activatePersistedCache,
  cacheOwnerFor,
  PERSIST_KEY,
  CACHE_OWNER_KEY,
} from './query-client';

const TENANT_META_KEY = 'tenantMeta';

/** A persisted client as the persister writes it, holding one accounts query. */
function persistedClient(name: string) {
  return JSON.stringify({
    timestamp: Date.now(),
    buster: '',
    clientState: {
      mutations: [],
      queries: [{
        queryKey: ['accounts'],
        queryHash: '["accounts"]',
        state: {
          data: { accounts: [{ id: 1, name }] }, dataUpdateCount: 1, dataUpdatedAt: Date.now(), error: null,
          errorUpdateCount: 0, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null,
          isInvalidated: false, status: 'success', fetchStatus: 'idle',
        },
      }],
    },
  });
}

beforeEach(() => {
  clearPersistedQueryCache();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clearPersistedQueryCache (#155, #78 R4)', () => {
  it('drops cached queries, the persisted copy, tenantMeta and the owner marker', () => {
    queryClient.setQueryData(['accounts'], { accounts: [{ id: 1, name: 'Checking' }] });
    window.localStorage.setItem(PERSIST_KEY, persistedClient('Checking'));
    window.localStorage.setItem(TENANT_META_KEY, JSON.stringify({ id: 't1', banks: [] }));
    window.localStorage.setItem(CACHE_OWNER_KEY, 'u1:t1');

    clearPersistedQueryCache();

    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
    expect(window.localStorage.getItem(TENANT_META_KEY)).toBeNull();
    expect(window.localStorage.getItem(CACHE_OWNER_KEY)).toBeNull();
  });
});

describe('activatePersistedCache (#78 R4)', () => {
  it('restores the cache written by the same user and tenant', async () => {
    window.localStorage.setItem(PERSIST_KEY, persistedClient('Mine'));
    window.localStorage.setItem(CACHE_OWNER_KEY, 'u1:t1');

    await activatePersistedCache('u1:t1');

    expect(queryClient.getQueryData(['accounts'])).toEqual({ accounts: [{ id: 1, name: 'Mine' }] });
    expect(window.localStorage.getItem(CACHE_OWNER_KEY)).toBe('u1:t1');
  });

  it("wipes another owner's cache and tenantMeta instead of restoring them", async () => {
    window.localStorage.setItem(PERSIST_KEY, persistedClient('Theirs'));
    window.localStorage.setItem(TENANT_META_KEY, JSON.stringify({ id: 't1', banks: [{ id: 9 }] }));
    window.localStorage.setItem(CACHE_OWNER_KEY, 'u1:t1');

    await activatePersistedCache('u2:t2');

    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
    expect(window.localStorage.getItem(TENANT_META_KEY)).toBeNull();
    expect(window.localStorage.getItem(CACHE_OWNER_KEY)).toBe('u2:t2');
  });

  it('treats a cache without an owner marker (written before #78) as foreign', async () => {
    window.localStorage.setItem(PERSIST_KEY, persistedClient('Legacy'));

    await activatePersistedCache('u1:t1');

    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
  });

  it('the same user in a different tenant is a different owner', async () => {
    window.localStorage.setItem(PERSIST_KEY, persistedClient('Tenant one'));
    window.localStorage.setItem(CACHE_OWNER_KEY, 'u1:t1');

    await activatePersistedCache('u1:t2');

    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
  });

  it('persists new data for the active owner, and a pending write never survives a clear', async () => {
    vi.useFakeTimers();
    await activatePersistedCache('u1:t1');

    queryClient.setQueryData(['accounts'], { accounts: [{ id: 1, name: 'A' }] });
    clearPersistedQueryCache();
    vi.advanceTimersByTime(2000);
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();

    await activatePersistedCache('u1:t1');
    queryClient.setQueryData(['accounts'], { accounts: [{ id: 1, name: 'B' }] });
    vi.advanceTimersByTime(2000);
    expect(window.localStorage.getItem(PERSIST_KEY)).toContain('"name":"B"');
  });

  it('switching owners in memory clears the previous owner first', async () => {
    await activatePersistedCache('u1:t1');
    queryClient.setQueryData(['accounts'], { accounts: [{ id: 1, name: 'A' }] });

    await activatePersistedCache('u2:t2');

    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
  });

  it('cacheOwnerFor keys on user and tenant', () => {
    expect(cacheOwnerFor({ id: 'u1', tenant: { id: 't1' } })).toBe('u1:t1');
    expect(cacheOwnerFor({ id: 'u1', tenantId: 't9' })).toBe('u1:t9');
  });
});
