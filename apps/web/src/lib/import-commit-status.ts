/**
 * Decide whether a StagedImport status observation represents a commit
 * finishing, and which kind.
 *
 * `useStagedImport` (use-imports.ts) only polls while status is PROCESSING
 * or COMMITTING. A fast commit (few rows) can finish inside the 2s polling
 * interval, so the UI never observes the intermediate COMMITTING state — by
 * the next refetch, status is already back to READY/COMMITTED with a
 * commitResult. Gating purely on `prevStatus === 'COMMITTING'` therefore
 * silently misses fast commits and shows no completion feedback at all.
 * `commitInFlight` covers that: it's true whenever a commit was initiated
 * (set by the caller's mutation `onSuccess`) regardless of whether
 * COMMITTING was ever observed. Mirrors the equivalent `commitInFlightRef`
 * fix already in smart-import.tsx.
 */
export function commitTransitionKind(
  prevStatus: string | undefined,
  currentStatus: string | undefined,
  commitInFlight: boolean,
): 'committed' | 'partial' | null {
  if (!currentStatus) return null;
  const wasCommitting = prevStatus === 'COMMITTING';
  if (!wasCommitting && !commitInFlight) return null;
  if (currentStatus === 'COMMITTED') return 'committed';
  if (currentStatus === 'READY') return 'partial';
  return null;
}
