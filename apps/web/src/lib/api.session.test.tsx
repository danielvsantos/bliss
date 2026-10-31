/**
 * Session refresh in the API client (#156, R24–R25, AC7).
 *
 * The 401 interceptor refreshes once and retries; concurrent 401s — including
 * the resume refetch burst from useResumeRefresh (#155) — share a single
 * POST /api/auth/refresh, and `auth:session-expired` fires only when that
 * refresh fails.
 */
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';

vi.mock('@/lib/pwa/register', () => ({ checkForPwaUpdate: vi.fn().mockResolvedValue(undefined) }));

type ApiModule = typeof import('./api');

let refreshCalls = 0;
let refreshOk = true;
let accessValid = false;
let expired: ReturnType<typeof vi.fn>;

async function freshApi(): Promise<ApiModule> {
  vi.resetModules();
  return import('./api');
}

/** /api/integrations answers 401 until a refresh succeeds. */
function useServer() {
  server.use(
    http.post('/api/auth/refresh', async () => {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      if (!refreshOk) return HttpResponse.json({ code: 'SESSION_EXPIRED' }, { status: 401 });
      accessValid = true;
      return HttpResponse.json({ ok: true });
    }),
    http.get('/api/integrations', () => (accessValid
      ? HttpResponse.json({ integrations: [] })
      : HttpResponse.json({ error: 'Invalid or expired token' }, { status: 401 }))),
    http.get('/api/auth/session', () => (accessValid
      ? HttpResponse.json({ user: { id: 'u1', email: 'a@b.co' } })
      : HttpResponse.json({ error: 'Authentication required' }, { status: 401 }))),
    http.post('/api/auth/reauth', () => HttpResponse.json({ code: 'REAUTH_FAILED' }, { status: 401 })),
  );
}

beforeEach(() => {
  refreshCalls = 0;
  refreshOk = true;
  accessValid = false;
  expired = vi.fn();
  window.addEventListener('auth:session-expired', expired);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useServer();
});

afterEach(() => {
  window.removeEventListener('auth:session-expired', expired);
  vi.restoreAllMocks();
});

describe('401 → single-flight refresh', () => {
  it('refreshes once for 10 concurrent 401s and retries every request', async () => {
    const { api } = await freshApi();

    const results = await Promise.all(Array.from({ length: 10 }, () => api.getIntegrations()));

    expect(results).toHaveLength(10);
    results.forEach((r) => expect(r).toEqual({ integrations: [] }));
    expect(refreshCalls).toBe(1);
    expect(expired).not.toHaveBeenCalled();
  });

  it('fires auth:session-expired once when the refresh fails, and never retries the refresh', async () => {
    refreshOk = false;
    const { api } = await freshApi();

    const outcomes = await Promise.allSettled([api.getIntegrations(), api.getIntegrations()]);

    expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('notifies again after a new sign-in re-arms the event', async () => {
    refreshOk = false;
    const { api, resetSessionExpired } = await freshApi();

    await expect(api.getIntegrations()).rejects.toBeDefined();
    resetSessionExpired();
    await expect(api.getIntegrations()).rejects.toBeDefined();

    expect(expired).toHaveBeenCalledTimes(2);
  });

  it('lets the session check refresh, and stays silent when it cannot (R25)', async () => {
    const { api } = await freshApi();
    await expect(api.getSession()).resolves.toEqual({ user: { id: 'u1', email: 'a@b.co' } });
    expect(refreshCalls).toBe(1);

    accessValid = false;
    refreshOk = false;
    const again = await freshApi();
    await expect(again.api.getSession()).rejects.toBeDefined();
    expect(expired).not.toHaveBeenCalled();
  });

  it('never refreshes or signs out on a wrong password in the confirm-identity dialog', async () => {
    const { api } = await freshApi();

    await expect(api.reauthWithPassword('wrong')).rejects.toBeDefined();

    expect(refreshCalls).toBe(0);
    expect(expired).not.toHaveBeenCalled();
  });

  it('isReauthRequired recognises 403 REAUTH_REQUIRED only', async () => {
    const { isReauthRequired } = await freshApi();
    expect(isReauthRequired({ response: { status: 403, data: { code: 'REAUTH_REQUIRED' } } })).toBe(true);
    expect(isReauthRequired({ response: { status: 403, data: { code: 'OTHER' } } })).toBe(false);
    expect(isReauthRequired(new Error('x'))).toBe(false);
  });
});

describe('PWA resume with an expired access token (AC7)', () => {
  it('the resume refetch burst makes exactly one refresh call and every query succeeds', async () => {
    const { api } = await freshApi();
    const { useResumeRefresh } = await import('@/hooks/use-resume-refresh');

    let clock = 1_000_000;
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);

    // Start signed in, with data on screen.
    accessValid = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { result } = renderHook(
      () => {
        useResumeRefresh(() => clock);
        return keys.map((k) => useQuery({ queryKey: ['integrations', k], queryFn: () => api.getIntegrations() }));
      },
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(result.current.every((q) => q.isSuccess)).toBe(true));

    // Backgrounded for 6 minutes; the access token expired meanwhile.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    accessValid = false;
    clock += 6 * 60_000;
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(refreshCalls).toBe(1));
    await waitFor(() => expect(result.current.every((q) => q.isSuccess && !q.isFetching)).toBe(true));
    expect(result.current.every((q) => !q.isError)).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(expired).not.toHaveBeenCalled();
  });
});
