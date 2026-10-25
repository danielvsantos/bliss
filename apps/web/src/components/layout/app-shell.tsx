import React, { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useCompleteOnboardingStep } from "@/hooks/use-onboarding-progress";
import { usePlaidTransactions } from "@/hooks/use-plaid-review";
import { usePendingImports } from "@/hooks/use-imports";
import { useAuth } from "@/hooks/use-auth";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { OfflineScreen } from "@/components/pwa/offline-screen";

// Map page paths to checklist step keys
const PAGE_TO_CHECKLIST: Record<string, string> = {
  "/agents/review": "reviewTransactions",
  "/reports/expenses": "exploreExpenses",
  "/reports/financial-summary": "checkPnL",
};

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const location = useLocation();
  const { user } = useAuth();
  const isViewer = user?.role === "viewer";
  const isOnline = useOnlineStatus();
  const completeStep = useCompleteOnboardingStep();
  const trackedPaths = useRef(new Set<string>());

  // Page-visit tracker: mark checklist items done when user visits the corresponding page
  useEffect(() => {
    const step = PAGE_TO_CHECKLIST[location.pathname];
    if (step && !trackedPaths.current.has(location.pathname)) {
      trackedPaths.current.add(location.pathname);
      completeStep.mutate({ step });
    }
  }, [location.pathname, completeStep]);

  // Badge count in browser tab title
  const { data: plaidData } = usePlaidTransactions({ limit: 1 });
  const { data: pendingImportData } = usePendingImports();
  const reviewCount =
    (plaidData?.summary?.classified ?? 0) +
    (pendingImportData?.imports ?? []).reduce(
      (sum: number, imp: { pendingRowCount?: number }) => sum + (imp.pendingRowCount ?? 0), 0,
    );
  useEffect(() => {
    document.title = reviewCount > 0 ? `(${reviewCount}) Bliss` : 'Bliss';
  }, [reviewCount]);

  const toggleSidebar = () => {
    setSidebarOpen(!sidebarOpen);
  };

  return (
    // Installed app (#155): the shell is pinned to the screen edges rather than
    // sized with dvh — in iOS standalone mode with the translucent status bar
    // 100dvh already excludes the status bar, so dvh arithmetic left an empty
    // band at the bottom. The shell pads itself below the status bar and the
    // landscape notch; <main> pads its scroll content above the home indicator
    // so its background runs to the bottom edge. All insets are 0 in a tab.
    <div className="fixed inset-0 flex overflow-hidden pt-[env(safe-area-inset-top)] pwa-safe-x">
      {/* Sidebar - hidden on mobile unless toggled */}
      <div
        className={cn(
          "fixed top-[env(safe-area-inset-top)] bottom-0 left-0 z-50 w-64 transform transition-transform duration-300 ease-in-out pb-[env(safe-area-inset-bottom)] bg-background md:relative md:top-0 md:pb-0 md:bg-transparent md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && isMobile && (
        <div
          className="fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {isViewer && (
          <div className="flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium bg-brand-primary/10 text-brand-primary border-b border-brand-primary/20">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            You have view-only access to this account. You can navigate and explore, but cannot perform actions.
          </div>
        )}
        <Header
          sidebarOpen={sidebarOpen}
          onSidebarToggle={toggleSidebar}
        />
        <main className="flex-1 overflow-auto px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-5 md:pt-5 md:pb-[calc(1.25rem+env(safe-area-inset-bottom))] lg:px-6 lg:pt-6 lg:pb-[calc(1.5rem+env(safe-area-inset-bottom))] bg-gray-50 dark:bg-gray-900">
          {/* Offline: no figures at all, not even the persisted cache (#155). */}
          {isOnline ? children : <OfflineScreen />}
        </main>
      </div>
    </div>
  );
}
