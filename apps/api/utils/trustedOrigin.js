import { StatusCodes } from 'http-status-codes';
import { allowedOrigins } from './allowedOrigins.js';

/**
 * Origin guard for the session-lifecycle routes (#156, R12): refresh, signout,
 * change-password, sign-out-others and reauth.
 *
 * The session cookies are `SameSite=None` in cross-origin deployments, so the
 * browser attaches them to a cross-site POST too. These routes therefore only
 * accept a request whose `Origin` is the configured frontend; when `Origin` is
 * absent the `Referer` origin must match instead, and a request carrying
 * neither is refused.
 */

export const UNTRUSTED_ORIGIN = 'UNTRUSTED_ORIGIN';

function originOf(value) {
  if (typeof value !== 'string' || value === '' || value === 'null') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * @param {import('next').NextApiRequest} req
 * @returns {boolean}
 */
export function isTrustedOrigin(req) {
  const trusted = new Set(allowedOrigins().map(originOf).filter(Boolean));
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    const parsed = originOf(origin);
    return parsed !== null && trusted.has(parsed);
  }
  const referer = originOf(req.headers?.referer);
  return referer !== null && trusted.has(referer);
}

/**
 * Responds `403 UNTRUSTED_ORIGIN` and returns false when the request's origin
 * is not trusted; returns true otherwise.
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 * @returns {boolean}
 */
export function requireTrustedOrigin(req, res) {
  if (isTrustedOrigin(req)) return true;
  res.status(StatusCodes.FORBIDDEN).json({ error: 'Untrusted request origin', code: UNTRUSTED_ORIGIN });
  return false;
}
