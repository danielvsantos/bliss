import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../../utils/cors.js';
import { rateLimiters } from '../../../../utils/rateLimit.js';
import { requireTrustedOrigin } from '../../../../utils/trustedOrigin.js';
import { revokeOtherSessions } from '../../../../services/session.service.js';

/**
 * POST /api/auth/sessions/revoke-others (#156) — "Sign out of all other
 * devices".
 *
 * Authenticated by the refresh cookie, not withAuth, so every role (viewers
 * included) can use it. Every other session of the user ends on its next
 * request; this device stays signed in (fresh access cookie).
 *   → 200 { revoked: n }
 *   → 401 SESSION_EXPIRED (no live session on this device; cookies cleared)
 */
export default async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.changePassword(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(StatusCodes.METHOD_NOT_ALLOWED).end(`Method ${req.method} Not Allowed`);
    return;
  }

  if (!requireTrustedOrigin(req, res)) return;

  try {
    const result = await revokeOtherSessions(req, res);
    if (!result.ok) {
      res.status(result.status).json({ error: 'Session expired', code: result.code });
      return;
    }
    res.status(StatusCodes.OK).json({ revoked: result.revoked });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Revoke other sessions error:', { message: error?.message });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to sign out other devices' });
  }
}
