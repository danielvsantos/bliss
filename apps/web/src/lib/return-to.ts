/**
 * Post-sign-in return path (#89 — OAuth consent needs the user back on
 * /oauth/consent after signing in). Only same-origin relative paths are
 * accepted, so `?returnTo=` can never become an open redirect.
 */

const STORAGE_KEY = 'bliss.returnTo';

/** A safe relative path, or null. Rejects `//host`, `/\host`, absolute URLs. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  // No control characters (newlines, tabs, NUL): they can smuggle header or URL tricks.
  if ([...value].some((ch) => ch.charCodeAt(0) < 0x20)) return null;
  if (value === '/auth' || value.startsWith('/auth?') || value.startsWith('/auth/')) return null;
  return value;
}

/** The `returnTo` query parameter of the current page, validated. */
export function returnToFromLocation(search: string = window.location.search): string | null {
  return safeReturnTo(new URLSearchParams(search).get('returnTo'));
}

/** `/auth` with the given path as returnTo (plain `/auth` for the home page). */
export function authPathFor(path: string): string {
  const safe = safeReturnTo(path);
  return safe && safe !== '/' ? `/auth?returnTo=${encodeURIComponent(safe)}` : '/auth';
}

/** Keep returnTo across a full-page redirect (Google sign-in). */
export function rememberReturnTo(search: string = window.location.search): void {
  const value = returnToFromLocation(search);
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, value);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode): the user lands on the home page.
  }
}

/** Read and clear the remembered returnTo. */
export function consumeReturnTo(): string | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    return safeReturnTo(value);
  } catch {
    return null;
  }
}
