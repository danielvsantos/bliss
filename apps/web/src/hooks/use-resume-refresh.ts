import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { checkForPwaUpdate } from '@/lib/pwa/register';

/** Background time after which coming back refetches what is on screen. */
export const RESUME_REFRESH_AFTER_MS = 5 * 60_000;

/**
 * Resume freshness (#155, PRD R11). An installed app is resumed far more often
 * than it is reloaded, and TanStack's focus refetch skips queries that are
 * still inside their staleTime. After at least RESUME_REFRESH_AFTER_MS in the
 * background, returning invalidates the active queries (so the visible page
 * refetches) and checks for a new build. Mounted once, in AppShell.
 */
export function useResumeRefresh(now: () => number = Date.now): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? now() : null;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = now();
        return;
      }
      if (hiddenAt !== null && now() - hiddenAt >= RESUME_REFRESH_AFTER_MS) {
        void queryClient.invalidateQueries({ refetchType: 'active' });
        void checkForPwaUpdate(now, true);
      }
      hiddenAt = null;
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [queryClient, now]);
}
