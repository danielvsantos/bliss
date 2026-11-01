/**
 * Onboarding step 2 (#154): provider-neutral copy, both bank providers plus
 * the spreadsheet option, the Plaid path unchanged, and the Enable Banking
 * completion recorded sequentially and bounded before the bank redirect.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api from '@/lib/api';
import OnboardingPage from './onboarding';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('react-type-animation', () => ({
  TypeAnimation: ({ sequence }: { sequence: Array<string | (() => void)> }) => {
    React.useEffect(() => {
      for (const s of sequence) if (typeof s === 'function') s();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- run once, like the real animation
    }, []);
    return <span>{sequence.filter((s) => typeof s === 'string').join('')}</span>;
  },
}));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u1', tenantId: 't1', role: 'admin' } }) }));
vi.mock('@/hooks/use-metadata', () => ({ useMetadata: () => ({ data: { countries: [], currencies: [] } }) }));
const setCurrentStep = vi.fn();
vi.mock('@/hooks/use-onboarding', () => ({
  useOnboarding: () => ({
    currentStep: 'connect',
    setCurrentStep,
    preferences: { countries: [], currencies: [] },
    setCountries: vi.fn(),
    setCurrencies: vi.fn(),
  }),
}));
const mutate = vi.fn();
vi.mock('@/hooks/use-onboarding-progress', () => ({ useCompleteOnboardingStep: () => ({ mutate }) }));
vi.mock('@/lib/api', () => ({ default: { completeOnboardingStep: vi.fn() } }));

// The provider cards have their own suite; here they only expose the callbacks.
let redirectDone: Promise<void> | null = null;
vi.mock('@/components/onboarding/bank-provider-options', () => ({
  BankProviderOptions: ({
    onPlaidComplete,
    onEnableBankingRedirect,
  }: {
    onPlaidComplete: () => Promise<void>;
    onEnableBankingRedirect: () => Promise<void>;
  }) => (
    <div data-testid="bank-provider-options">
      <button onClick={() => onPlaidComplete()}>plaid-done</button>
      <button onClick={() => { redirectDone = onEnableBankingRedirect(); }}>eb-redirect</button>
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  redirectDone = null;
  vi.mocked(api.completeOnboardingStep).mockResolvedValue({ onboardingProgress: {}, onboardingCompletedAt: null } as never);
});
afterEach(() => vi.useRealTimers());

describe('Onboarding step 2 (#154)', () => {
  it('renders provider-neutral copy, both providers and the spreadsheet option', async () => {
    render(<OnboardingPage />);
    expect(screen.getByText('onboarding.connect.title')).toBeInTheDocument();
    expect(screen.getByText('onboarding.connect.subtitle')).toBeInTheDocument();
    expect(await screen.findByTestId('bank-provider-options')).toBeInTheDocument();
    expect(screen.getByText('onboarding.connect.importTitle')).toBeInTheDocument();
    expect(screen.queryByText(/Plaid/)).not.toBeInTheDocument();
  });

  it('Plaid path is unchanged: step2_connect{plaid}, connectBank, setupComplete, then /', async () => {
    render(<OnboardingPage />);
    fireEvent.click(await screen.findByText('plaid-done'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(mutate).toHaveBeenCalledWith({ step: 'step2_connect', data: { method: 'plaid' } });
    expect(mutate).toHaveBeenCalledWith({ step: 'connectBank' });
    expect(api.completeOnboardingStep).toHaveBeenCalledWith('setupComplete');
  });

  it('Enable Banking: step2_connect{enable_banking} then setupComplete, sequentially, no navigation', async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => {};
    vi.mocked(api.completeOnboardingStep).mockImplementation((step: string) => {
      calls.push(`start:${step}`);
      return new Promise((resolve) => {
        const done = () => { calls.push(`end:${step}`); resolve({ onboardingProgress: {}, onboardingCompletedAt: null } as never); };
        if (step === 'step2_connect') releaseFirst = done;
        else done();
      });
    });
    render(<OnboardingPage />);
    fireEvent.click(await screen.findByText('eb-redirect'));
    await waitFor(() => expect(calls).toEqual(['start:step2_connect']));
    act(() => releaseFirst());
    await act(async () => { await redirectDone; });
    expect(calls).toEqual(['start:step2_connect', 'end:step2_connect', 'start:setupComplete', 'end:setupComplete']);
    expect(api.completeOnboardingStep).toHaveBeenCalledWith('step2_connect', { method: 'enable_banking' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Enable Banking: a failed write does not stop the second one', async () => {
    vi.mocked(api.completeOnboardingStep)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ onboardingProgress: {}, onboardingCompletedAt: null } as never);
    render(<OnboardingPage />);
    fireEvent.click(await screen.findByText('eb-redirect'));
    await act(async () => { await redirectDone; });
    expect(api.completeOnboardingStep).toHaveBeenLastCalledWith('setupComplete');
  });

  it('Enable Banking: a hung write resolves after the 5 s cap so the redirect goes ahead', async () => {
    vi.mocked(api.completeOnboardingStep).mockImplementation(() => new Promise(() => {}));
    render(<OnboardingPage />);
    const button = await screen.findByText('eb-redirect');
    vi.useFakeTimers();
    fireEvent.click(button);
    let settled = false;
    redirectDone!.then(() => { settled = true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(4900); });
    expect(settled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(settled).toBe(true);
  });
});
