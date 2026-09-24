import { describe, it, expect } from 'vitest';
import { commitTransitionKind } from './import-commit-status';

describe('commitTransitionKind', () => {
  it('returns null when there is no current status', () => {
    expect(commitTransitionKind('COMMITTING', undefined, false)).toBeNull();
  });

  it('returns null on first observation with no commit in flight (no false positive on mount)', () => {
    // prevStatus is undefined on the very first effect run, even if the
    // import happens to already be READY/COMMITTED from a past session.
    expect(commitTransitionKind(undefined, 'READY', false)).toBeNull();
    expect(commitTransitionKind(undefined, 'COMMITTED', false)).toBeNull();
  });

  it('detects a commit via the observed COMMITTING -> COMMITTED transition', () => {
    expect(commitTransitionKind('COMMITTING', 'COMMITTED', false)).toBe('committed');
  });

  it('detects a partial commit via the observed COMMITTING -> READY transition', () => {
    expect(commitTransitionKind('COMMITTING', 'READY', false)).toBe('partial');
  });

  // Regression: a fast commit (few rows) can finish inside the 2s polling
  // interval, so COMMITTING is never observed — prevStatus stays whatever it
  // was before the commit (e.g. 'READY'). Without commitInFlight, this used
  // to return null and silently show no completion feedback at all.
  it('detects a fast commit via commitInFlight even when COMMITTING was never observed', () => {
    expect(commitTransitionKind('READY', 'COMMITTED', true)).toBe('committed');
    expect(commitTransitionKind('READY', 'READY', true)).toBe('partial');
  });

  it('returns null when neither COMMITTING was observed nor a commit is in flight', () => {
    expect(commitTransitionKind('READY', 'COMMITTED', false)).toBeNull();
    expect(commitTransitionKind('PROCESSING', 'READY', false)).toBeNull();
  });

  it('returns null for a status that is neither COMMITTED nor READY', () => {
    expect(commitTransitionKind('COMMITTING', 'PROCESSING', true)).toBeNull();
  });
});
