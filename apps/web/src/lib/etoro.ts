import type { CopyTradeStatus, EtoroConnection, EtoroCopy } from '@/types/api';

/**
 * eToro copy trading (#143) client helpers.
 */

export type CopyTradeBadgeState = 'linked' | 'needsReconnect' | 'closed' | 'notLinked';

/** What a Copy Trading holding's link status means for the user (R12); null for any other holding. */
export function copyTradeBadgeState(copyTrade: CopyTradeStatus | undefined | null): CopyTradeBadgeState | null {
  if (!copyTrade) return null;
  if (!copyTrade.linked) return 'notLinked';
  if (copyTrade.connectionStatus === 'NEEDS_RECONNECT') return 'needsReconnect';
  if (copyTrade.status === 'CLOSED') return 'closed';
  return 'linked';
}

/** Mirrors normalizeUsername() in apps/api/services/etoro.service.js. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,39}$/;

/** `@TopInvestor ` → `topinvestor`. */
export function normalizeEtoroUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function isValidEtoroUsername(value: string): boolean {
  return USERNAME_PATTERN.test(normalizeEtoroUsername(value));
}

/** A copy offered by "Switch to Copy Trading": not linked to a holding yet. */
export type CopyCandidate = Pick<EtoroCopy, 'id' | 'parentUsername' | 'status' | 'lastValue' | 'lastValueCurrency'>;

/**
 * The copies a holding can be switched to, from the eToro connection of the
 * holding's account: only copies not linked yet, active ones first. A copy
 * only links to a holding in its connection's account, so when the account
 * has no connection but another account does, that connection is returned as
 * `otherAccount` to warn the user.
 */
export function copyCandidatesFor(
  connections: EtoroConnection[] | undefined,
  accountId: number | null | undefined,
): { candidates: CopyCandidate[]; otherAccount: EtoroConnection | null } {
  const list = connections ?? [];
  const own = list.filter((c) => accountId != null && c.accountId === accountId);
  const candidates = own
    .flatMap((c) => c.copies)
    .filter((copy) => !copy.linkedHolding)
    .sort((a, b) => (a.status === b.status ? a.parentUsername.localeCompare(b.parentUsername) : a.status === 'ACTIVE' ? -1 : 1));
  return { candidates, otherAccount: own.length === 0 ? list[0] ?? null : null };
}

/**
 * The copy whose investor's username appears in the holding's name as a whole
 * word, e.g. "Copy Traders:AmitKup (Amit Kupfer)" → amitkup. The longest match
 * wins; null when none matches.
 */
export function matchCopyFromName(name: string, usernames: string[]): string | null {
  const text = name.toLowerCase();
  const isWordChar = (ch: string | undefined) => ch != null && /[a-z0-9_.-]/.test(ch);
  let best: string | null = null;
  for (const username of usernames) {
    let from = 0;
    for (let at = text.indexOf(username, from); at !== -1; at = text.indexOf(username, from)) {
      if (!isWordChar(text[at - 1]) && !isWordChar(text[at + username.length])) {
        if (!best || username.length > best.length) best = username;
        break;
      }
      from = at + 1;
    }
  }
  return best;
}
