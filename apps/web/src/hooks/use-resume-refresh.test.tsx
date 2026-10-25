import React from 'react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const checkForPwaUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pwa/register', () => ({ checkForPwaUpdate: (...args: unknown[]) => checkForPwaUpdate(...args) }));

import { useResumeRefresh, RESUME_REFRESH_AFTER_MS } from './use-resume-refresh';

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useResumeRefresh (#155, PRD R11/AC11)', () => {
  let clock = 0;
  const now = () => clock;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    clock = 1_000_000;
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    queryClient = new QueryClient();
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    renderHook(() => useResumeRefresh(now), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
  });

  it('refetches the visible page and checks for a build after 6 minutes away', () => {
    setVisibility('hidden');
    clock += 6 * 60_000;
    setVisibility('visible');
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ refetchType: 'active' });
    expect(checkForPwaUpdate).toHaveBeenCalledTimes(1);
  });

  it('does nothing after only 4 minutes away', () => {
    setVisibility('hidden');
    clock += 4 * 60_000;
    setVisibility('visible');
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(checkForPwaUpdate).not.toHaveBeenCalled();
  });

  it('uses the threshold inclusively', () => {
    setVisibility('hidden');
    clock += RESUME_REFRESH_AFTER_MS;
    setVisibility('visible');
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
  });
});
