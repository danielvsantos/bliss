/**
 * Enable Banking (#132) display helpers shared by the connect dialog, the
 * mapping dialog and the bank connection card.
 */

/** A consent this close to its end shows as "Expiring" (matches the notification threshold). */
const EXPIRING_SOON_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type EnableBankingConnectionState =
  | 'active'
  | 'expiring'
  | 'expired'
  | 'error'
  | 'disconnected'
  | 'needsMapping'
  | 'paused';

/**
 * Derive the user-facing state of an Enable Banking connection from its
 * PlaidItem status and consent expiry. LOGIN_REQUIRED means the consent
 * expired or was revoked at the bank. `paused` (#148): the tenant has no
 * Enable Banking credentials, so nothing syncs until an admin adds them.
 */
export function getConnectionState(
  item: { status: string; consentExpiration?: string | null; paused?: boolean },
  now: Date = new Date(),
): { state: EnableBankingConnectionState; daysLeft: number | null } {
  if (item.paused && item.status !== 'REVOKED') return { state: 'paused', daysLeft: null };
  const expiry = item.consentExpiration ? new Date(item.consentExpiration) : null;
  const daysLeft = expiry && !Number.isNaN(expiry.getTime())
    ? Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS)
    : null;

  switch (item.status) {
    case 'REVOKED':
      return { state: 'disconnected', daysLeft };
    case 'PENDING_SELECTION':
      return { state: 'needsMapping', daysLeft };
    case 'LOGIN_REQUIRED':
      return { state: 'expired', daysLeft };
    case 'ACTIVE':
      if (daysLeft !== null && daysLeft <= 0) return { state: 'expired', daysLeft };
      if (daysLeft !== null && daysLeft <= EXPIRING_SOON_DAYS) return { state: 'expiring', daysLeft };
      return { state: 'active', daysLeft };
    default:
      return { state: 'error', daysLeft };
  }
}

/** Format a `YYYY-MM-DD` calendar day without a timezone shift. */
export function formatIsoDay(isoDay: string, language?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(isoDay);
  if (Number.isNaN(date.getTime())) return isoDay;
  return date.toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Format an ISO timestamp as a localised date (and optionally time). */
export function formatDate(iso: string, language?: string, withTime = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return withTime
    ? date.toLocaleString(language, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Localised country name for an ISO 3166-1 alpha-2 code (falls back to the code). */
export function countryName(code: string, language?: string): string {
  try {
    const names = new Intl.DisplayNames(language ? [language] : undefined, { type: 'region' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Format a decimal string balance in its currency. */
export function formatBalance(amount: string, currency: string | null, language?: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  if (!currency) return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  try {
    return new Intl.NumberFormat(language, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}
