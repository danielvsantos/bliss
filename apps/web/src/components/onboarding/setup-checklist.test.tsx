import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { SetupChecklist } from './setup-checklist';
import * as OnboardingHooks from '@/hooks/use-onboarding-progress';
import type { ReactNode } from 'react';
import { mockQueryResult, mockQueryLoading } from '@/test/mock-helpers';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock framer-motion to avoid animation issues in jsdom
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}));

// Mock the onboarding progress hook
vi.mock('@/hooks/use-onboarding-progress', () => ({
  useOnboardingProgress: vi.fn(),
  useCompleteOnboardingStep: vi.fn(() => ({ mutate: vi.fn() })),
}));

const mockActions = [
  { id: 'connect-bank', label: 'Connect Bank', description: 'desc', icon: <span data-testid="icon" />, href: '/connect', slot: 'onboarding' as const, priority: 1, visible: () => true },
  { id: 'add-account', label: 'Add Account', description: 'desc', icon: <span data-testid="icon" />, href: '/add', slot: 'onboarding' as const, priority: 2, visible: () => true }, // SHARES KEY with connect-bank
  { id: 'explore-expenses', label: 'Explore Expenses', description: 'desc', icon: <span data-testid="icon" />, href: '/expenses', slot: 'onboarding' as const, priority: 3, visible: () => true },
];

describe('SetupChecklist Component', () => {
  it('renders nothing if loading', () => {
    vi.mocked(OnboardingHooks.useOnboardingProgress).mockReturnValue(mockQueryLoading());

    const { container } = render(
      <MemoryRouter>
        <SetupChecklist actions={mockActions} />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders checklist items correctly, deduplicating shared keys', () => {
    vi.mocked(OnboardingHooks.useOnboardingProgress).mockReturnValue(
      mockQueryResult({
        onboardingProgress: {
          checklistDismissed: false,
          checklist: {
            connectBank: { done: true },
            exploreExpenses: { done: false },
          },
        },
      }),
    );

    render(
      <MemoryRouter>
        <SetupChecklist actions={mockActions} />
      </MemoryRouter>
    );

    // "connect-bank" and "add-account" map to the same key "connectBank",
    // so there should only be TWO total items rendered (Connect Bank + Explore Expenses)
    expect(screen.getByText('Get started with Bliss')).toBeInTheDocument();
    expect(screen.getByText('Connect Bank')).toBeInTheDocument();
    expect(screen.queryByText('Add Account')).not.toBeInTheDocument();
    expect(screen.getByText('Explore Expenses')).toBeInTheDocument();
    
    // Check completion count: 1 of 2 complete
    expect(screen.getByText(/1 of 2 complete/)).toBeInTheDocument();
  });

  it('renders nothing if checklist is dismissed', () => {
    vi.mocked(OnboardingHooks.useOnboardingProgress).mockReturnValue(
      mockQueryResult({
        onboardingProgress: {
          checklistDismissed: true,
          checklist: { connectBank: { done: false } },
        },
      }),
    );

    const { container } = render(
      <MemoryRouter>
        <SetupChecklist actions={mockActions} />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });
});
