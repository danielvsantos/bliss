import type { CopyTradeStatus } from '@/types/api';

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
