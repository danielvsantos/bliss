import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { api } from '@/lib/api';
import { useSignupMode } from './use-signup-mode';

vi.mock('@/lib/api');

function makeWrapper() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return wrapper;
}

describe('useSignupMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports invite-only from the public flag', async () => {
    vi.mocked(api.getSignupMode).mockResolvedValue({ inviteOnly: true });
    const { result } = renderHook(() => useSignupMode(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.inviteOnly).toBe(true));
  });

  it('is open while loading', () => {
    vi.mocked(api.getSignupMode).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSignupMode(), { wrapper: makeWrapper() });
    expect(result.current).toEqual({ inviteOnly: false });
  });

  // The server is authoritative; a failed flag request must not block sign-up.
  it('falls back to open mode when the request fails (after one retry)', async () => {
    vi.mocked(api.getSignupMode).mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useSignupMode(), { wrapper: makeWrapper() });
    await waitFor(() => expect(api.getSignupMode).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(result.current).toEqual({ inviteOnly: false });
  });
});
