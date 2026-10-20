import { describe, it, expect } from 'vitest';
import { copyTradeBadgeState, isValidEtoroUsername, normalizeEtoroUsername } from './etoro';

describe('eToro helpers (#143)', () => {
  it('maps a link status to a badge', () => {
    const linked = { linked: true as const, copyId: 'c', status: 'ACTIVE' as const, connectionStatus: 'ACTIVE' as const, lastValueAt: null, unmappedPct: null };
    expect(copyTradeBadgeState(undefined)).toBeNull();
    expect(copyTradeBadgeState({ linked: false })).toBe('notLinked');
    expect(copyTradeBadgeState(linked)).toBe('linked');
    expect(copyTradeBadgeState({ ...linked, status: 'CLOSED' })).toBe('closed');
    // A key to replace is the more urgent message, even for a closed copy.
    expect(copyTradeBadgeState({ ...linked, status: 'CLOSED', connectionStatus: 'NEEDS_RECONNECT' })).toBe('needsReconnect');
  });

  it('normalizes and validates usernames like the API', () => {
    expect(normalizeEtoroUsername(' @TopInvestor ')).toBe('topinvestor');
    expect(isValidEtoroUsername('@Top_Investor.1')).toBe(true);
    expect(isValidEtoroUsername('a')).toBe(false);
    expect(isValidEtoroUsername('bad name')).toBe(false);
  });
});
