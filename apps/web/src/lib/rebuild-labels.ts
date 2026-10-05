import type { RebuildScope } from '@/types/api';

/** Shared by the Maintenance tab and the rebuild history in Settings → Processing (#100). */

export function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return '—';
  const then = Date.parse(isoString);
  if (Number.isNaN(then)) return '—';
  const elapsed = Math.floor((Date.now() - then) / 1000);
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  return `${Math.floor(elapsed / 86400)}d ago`;
}

export const SCOPE_LABEL: Record<RebuildScope, string> = {
  // "Full rebuild" rather than "Full portfolio" — this scope runs the
  // entire chain (portfolio items → cash holdings → analytics →
  // valuation + loan processors), not just the portfolio piece.
  // Calling it "portfolio" was misleading in practice.
  'full-portfolio': 'Full rebuild',
  'full-analytics': 'Full analytics',
  'scoped-analytics': 'Scoped analytics',
  'single-asset': 'Single asset',
  'security-data': 'Securities data',
};
