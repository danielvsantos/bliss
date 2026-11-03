/**
 * The NextAuth (Google) cookie is single-use glue between Google and
 * /api/auth/google-token (#78 R2), never a session.
 *
 * `signedInAt` (ms) is written once by the NextAuth `jwt` callback at Google
 * sign-in. `iat` is not usable: NextAuth re-issues it on every
 * /api/auth/session read, which would let a copied cookie roll its own window
 * forward.
 */
export const GOOGLE_EXCHANGE_WINDOW_S = 5 * 60;

/**
 * Why a NextAuth token may not be exchanged, or null when it may.
 *
 * @param {object} token decoded NextAuth JWT
 * @param {object} ctx
 * @param {Date|null} ctx.sessionsRevokedAt the user's revocation stamp
 * @param {Date|null} ctx.lastAuthenticatedAt newest `UserSession.authenticatedAt` of the user (revoked rows included)
 * @param {number} [ctx.now] ms
 * @returns {null | 'missing' | 'expired' | 'revoked' | 'used'}
 */
export function googleExchangeRejection(token, { sessionsRevokedAt = null, lastAuthenticatedAt = null, now = Date.now() } = {}) {
  const signedInAt = Number(token?.signedInAt);
  if (!Number.isFinite(signedInAt) || signedInAt <= 0) return 'missing';
  if (now - signedInAt > GOOGLE_EXCHANGE_WINDOW_S * 1000 || signedInAt > now + 60_000) return 'expired';
  if (sessionsRevokedAt && sessionsRevokedAt.getTime() >= signedInAt) return 'revoked';
  // Every successful exchange writes authenticatedAt = now (startSession /
  // reauthenticate), so a replay of the same cookie finds that row.
  if (lastAuthenticatedAt && lastAuthenticatedAt.getTime() >= signedInAt) return 'used';
  return null;
}
