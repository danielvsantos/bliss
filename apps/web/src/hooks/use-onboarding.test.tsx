import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { OnboardingContext, type OnboardingContextType } from '@/lib/onboarding-context-value';
import { useOnboarding } from './use-onboarding';

const makeCtx = (overrides: Partial<OnboardingContextType> = {}): OnboardingContextType => ({
  currentStep: 'welcome',
  setCurrentStep: vi.fn(),
  preferences: { countries: [], currencies: [] },
  setCountries: vi.fn(),
  setCurrencies: vi.fn(),
  resetPreferences: vi.fn(),
  ...overrides,
});

const createWrapper = (ctx: OnboardingContextType) =>
  ({ children }: { children: React.ReactNode }) => (
    <OnboardingContext.Provider value={ctx}>{children}</OnboardingContext.Provider>
  );

describe('useOnboarding', () => {
  it('returns currentStep from context', () => {
    const ctx = makeCtx({ currentStep: 'connect' });
    const { result } = renderHook(() => useOnboarding(), { wrapper: createWrapper(ctx) });
    expect(result.current.currentStep).toBe('connect');
  });

  it('returns setCurrentStep from context', () => {
    const ctx = makeCtx();
    const { result } = renderHook(() => useOnboarding(), { wrapper: createWrapper(ctx) });
    expect(result.current.setCurrentStep).toBe(ctx.setCurrentStep);
  });

  it('returns preferences from context', () => {
    const ctx = makeCtx({ preferences: { countries: ['US'], currencies: ['USD'] } });
    const { result } = renderHook(() => useOnboarding(), { wrapper: createWrapper(ctx) });
    expect(result.current.preferences.countries).toEqual(['US']);
    expect(result.current.preferences.currencies).toEqual(['USD']);
  });

  it('throws when used outside an OnboardingProvider', () => {
    expect(() => renderHook(() => useOnboarding())).toThrow(
      'useOnboarding must be used within an OnboardingProvider',
    );
  });
});
