import { StatusCodes } from 'http-status-codes';
import { REAUTH_WINDOW_S } from '../services/session.service.js';

/**
 * Recent sign-in check (#156, R18): creating an integration, creating a key
 * and approving an OAuth connection require a real sign-in (password or
 * Google, `auth_time`) within the last 15 minutes. Refresh never resets it;
 * legacy tokens (no `auth_time`) are never recent.
 */

export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

/**
 * @param {{ authenticatedAt?: Date | null } | null | undefined} user
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isRecentAuth(user, now = new Date()) {
  const at = user?.authenticatedAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() <= REAUTH_WINDOW_S * 1000;
}

/**
 * Responds `403 REAUTH_REQUIRED` and returns false when the caller has not
 * signed in recently; returns true otherwise.
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 */
export function requireRecentAuth(req, res) {
  if (isRecentAuth(req.user)) return true;
  res.status(StatusCodes.FORBIDDEN).json({
    error: 'Please confirm it is you to continue',
    code: REAUTH_REQUIRED,
  });
  return false;
}
