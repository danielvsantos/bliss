import { useMemo } from 'react';
import { DASHBOARD_ACTIONS } from '@/lib/dashboard-actions';
import type { DashboardAction } from '@/lib/dashboard-actions';
import type { UserSignals } from '@/hooks/use-user-signals';

const MAX_QUICK_ACTIONS = 4;

export function useDashboardActions(signals: UserSignals) {
  return useMemo(() => {
    // Filter onboarding actions
    const onboardingActions = DASHBOARD_ACTIONS
      .filter(a => (a.slot === 'onboarding' || a.slot === 'both') && a.visible(signals, 'onboarding'))
      .sort((a, b) => a.priority - b.priority);

    // IDs currently visible in onboarding (not yet done)
    const onboardingIds = new Set(onboardingActions.map(a => a.id));

    // Filter quick actions — deduplicate 'both' actions that are still active in onboarding
    const quickActions = DASHBOARD_ACTIONS
      .filter(a => {
        if (a.slot !== 'quickAction' && a.slot !== 'both') return false;
        if (!a.visible(signals, 'quickAction')) return false;
        // Deduplicate: if a 'both' action is in the onboarding checklist (not yet done), skip it from quick actions
        if (a.slot === 'both' && onboardingIds.has(a.id) && !signals.onboardingComplete && !signals.checklistDismissed) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.priority - b.priority)
      .slice(0, MAX_QUICK_ACTIONS);

    return { quickActions, onboardingActions };
  }, [signals]);
}

export type { DashboardAction };
