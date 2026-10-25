import { describe, it, expect } from 'vitest';
import { queryClient, clearPersistedQueryCache } from './query-client';

const PERSIST_KEY = 'REACT_QUERY_OFFLINE_CACHE';

describe('clearPersistedQueryCache (#155, logout hygiene)', () => {
  it('drops cached queries and the persisted copy in localStorage', () => {
    queryClient.setQueryData(['accounts'], { accounts: [{ id: 1, name: 'Checking' }] });
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify({ clientState: { queries: [{ queryKey: ['accounts'] }] } }));

    clearPersistedQueryCache();

    expect(queryClient.getQueryData(['accounts'])).toBeUndefined();
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
  });
});
