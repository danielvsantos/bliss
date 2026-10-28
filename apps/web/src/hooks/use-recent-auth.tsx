import { useCallback, useRef, useState } from 'react';
import api, { isReauthRequired } from '@/lib/api';
import { ConfirmIdentityDialog, type ReauthMethod } from '@/components/auth/confirm-identity-dialog';

/**
 * Recent sign-in for key-minting actions (#156, R18–R21).
 *
 * - `ensureRecentAuth()` asks the API first (`GET /api/auth/reauth`) and only
 *   opens the confirm-identity dialog when the last sign-in is older than
 *   15 minutes. Call it *before* opening a form, so a Google redirect happens
 *   before the user types anything. Resolves true when it is OK to continue.
 * - `withReauthRetry(fn)` runs a mutation; on `403 REAUTH_REQUIRED` (the
 *   window lapsed while the form was open) it opens the dialog and retries
 *   once after a confirmation.
 * - Render `dialog` once in the component.
 *
 * @param returnTo where a Google step-up lands (defaults to the current page)
 */
export function useRecentAuth(returnTo?: string) {
  const [methods, setMethods] = useState<ReauthMethod[] | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    setMethods(null);
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(ok);
  }, []);

  const prompt = useCallback(async (knownMethods?: ReauthMethod[]): Promise<boolean> => {
    let available = knownMethods;
    if (!available) {
      try {
        available = (await api.getReauthStatus()).methods;
      } catch {
        available = ['password'];
      }
    }
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setMethods(available as ReauthMethod[]);
    });
  }, []);

  const ensureRecentAuth = useCallback(async (): Promise<boolean> => {
    let status: Awaited<ReturnType<typeof api.getReauthStatus>>;
    try {
      status = await api.getReauthStatus();
    } catch {
      // Unknown: let the action run; the API enforces the rule and
      // withReauthRetry recovers from a 403.
      return true;
    }
    if (status.recent) return true;
    return prompt(status.methods);
  }, [prompt]);

  const withReauthRetry = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (!isReauthRequired(error)) throw error;
      if (!(await prompt())) throw error;
      return fn();
    }
  }, [prompt]);

  const dialog = (
    <ConfirmIdentityDialog
      open={methods !== null}
      methods={methods ?? []}
      returnTo={returnTo}
      onConfirmed={() => finish(true)}
      onCancel={() => finish(false)}
    />
  );

  return { ensureRecentAuth, withReauthRetry, dialog };
}
