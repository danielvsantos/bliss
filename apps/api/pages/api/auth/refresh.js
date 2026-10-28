import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { requireTrustedOrigin } from '../../../utils/trustedOrigin.js';
import { refreshSession } from '../../../services/session.service.js';

/**
 * POST /api/auth/refresh (#156)
 *
 * Authenticated by the `bliss_rt` refresh cookie only (Path=/api/auth). On
 * success it rotates the refresh token and sets a new 15-min access cookie.
 * Failures clear both cookies and answer 401 SESSION_EXPIRED | SESSION_REVOKED.
 * See services/session.service.js for the rotation / grace / reuse rules.
 *
 * Integration keys never reach it (`/api/auth` is on INTEGRATION_DENYLIST).
 */
export default async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.refresh(req, res, (result) => {
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
    const result = await refreshSession(req, res);
    if (!result.ok) {
      res.status(result.status).json({ error: 'Session expired', code: result.code });
      return;
    }
    res.status(StatusCodes.OK).json({ ok: true });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Refresh error:', { message: error?.message });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Session refresh failed' });
  }
}
