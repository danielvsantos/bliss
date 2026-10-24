import { describe, it, expect } from 'vitest';
import { copyCandidatesFor, copyTradeBadgeState, isValidEtoroUsername, matchCopyFromName, normalizeEtoroUsername } from './etoro';
import type { EtoroConnection, EtoroCopy } from '@/types/api';

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

describe('Switch to Copy Trading helpers (#143)', () => {
  const copy = (parentUsername: string, extra: Partial<EtoroCopy> = {}): EtoroCopy => ({
    id: parentUsername, parentUsername, startedAt: null, status: 'ACTIVE', closedAt: null, lastValue: 100,
    lastValueCurrency: 'USD', lastValueAt: null, cashPct: null, unmappedPct: null, holdingsCount: 3, linkedHolding: null, ...extra,
  });
  const connection = (accountId: number, copies: EtoroCopy[]): EtoroConnection => ({
    id: `c${accountId}`, etoroUsername: 'me', accountId, account: { id: accountId, name: `Account ${accountId}` }, keyLast4: '1234',
    scopes: [], status: 'ACTIVE', errorCode: null, connectedAt: '', lastSyncAt: null, lastSyncStatus: null, lastSyncError: null, copies,
  });

  it('offers the unlinked copies of the holding\'s account, active ones first', () => {
    const conns = [connection(7, [
      copy('zed'), copy('amitkup'), copy('old', { status: 'CLOSED' }), copy('taken', { linkedHolding: { id: 1, symbol: 'taken' } }),
    ])];
    expect(copyCandidatesFor(conns, 7).candidates.map((c) => c.parentUsername)).toEqual(['amitkup', 'zed', 'old']);
    expect(copyCandidatesFor(conns, 7).otherAccount).toBeNull();
  });

  it('warns when the eToro connection uses another account', () => {
    const conns = [connection(7, [copy('amitkup')])];
    const { candidates, otherAccount } = copyCandidatesFor(conns, 9);
    expect(candidates).toEqual([]);
    expect(otherAccount?.accountId).toBe(7);
    expect(copyCandidatesFor([], 9)).toEqual({ candidates: [], otherAccount: null });
  });

  it('finds the investor in the holding\'s name as a whole word', () => {
    const names = ['amitkup', 'dvianasantos', 'jeppekirkbonde', 'misterg23'];
    expect(matchCopyFromName('Copy Traders:AmitKup (Amit Kupfer)', names)).toBe('amitkup');
    expect(matchCopyFromName('Funds:eToro copy: JeppeKirkBonde', names)).toBe('jeppekirkbonde');
    expect(matchCopyFromName('Private Equity:eToro - copy portfolio (dvianasantos / Daniel Santos)', names)).toBe('dvianasantos');
    expect(matchCopyFromName('Funds:eToro copy - Daniel Santos', names)).toBeNull();
    // Part of a longer word is not a match.
    expect(matchCopyFromName('Copy Traders:misterg234', names)).toBeNull();
  });
});
