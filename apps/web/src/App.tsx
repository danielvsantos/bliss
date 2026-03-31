import React, { useMemo } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { routes } from "./routes";
import NotFound from "./pages/NotFound";
import { withAuth } from "./components/withAuth";
import { Toaster } from "@/components/ui/toaster";
import { AppShell } from '@/components/layout/app-shell';
import { ErrorBoundary } from '@/components/error-boundary';
import { useForceTheme } from "./hooks/use-force-theme";

// Pre-wrap protected components once at module load time so that withAuth()
// is never called inside a render function. Calling withAuth() during render
// produces a new component reference every render, causing React to unmount
// and remount the component on every update — triggering useEffect loops.
const wrappedRoutes = routes.map((route) => ({
  ...route,
  ProtectedComponent: route.protected && route.component ? withAuth(route.component) : null,
}));

function RoutedApp() {
  const location = useLocation();
  useForceTheme();

  return (
    <Routes location={location}>
      {wrappedRoutes.map(({ path, element, component, protected: isProtected, ProtectedComponent }) => {
        // For protected routes, wrap with AppShell and withAuth
        if (isProtected && ProtectedComponent) {
          return (
            <Route
              key={path}
              path={path}
              element={
                <AppShell>
                  <ProtectedComponent />
                </AppShell>
              }
            />
          );
        }

        // For non-protected routes, render directly without AppShell
        return (
          <Route
            key={path}
            path={path}
            element={element || (component && React.createElement(component))}
          />
        );
      })}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
  <>
    <Toaster />
    <BrowserRouter>
      <ErrorBoundary>
        <RoutedApp />
      </ErrorBoundary>
    </BrowserRouter>
  </>
);

export default App;

 
