import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOnboardingProgress } from './use-onboarding-progress';

vi.mock('@/lib/api', () => {
  const mockApi = {
    getOnboardingProgress: vi.fn(),
    completeOnboardingStep: vi.fn(),
  };
  return { default: mockApi, api: mockApi };
});

import api from '@/lib/api';

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useOnboardingProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches onboarding progress', async () => {
    const mockProgress = {
      steps: [
        { id: 'connect-bank', completed: true },
        { id: 'import-csv', completed: false },
      ],
    };
    vi.mocked(api.getOnboardingProgress).mockResolvedValue(mockProgress);

    const { result } = renderHook(() => useOnboardingProgress(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockProgress);
    expect(api.getOnboardingProgress).toHaveBeenCalledOnce();
  });

  it('is enabled by default and queries immediately', async () => {
    vi.mocked(api.getOnboardingProgress).mockResolvedValue({ steps: [] });

    const { result } = renderHook(() => useOnboardingProgress(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getOnboardingProgress).toHaveBeenCalled();
  });
});
