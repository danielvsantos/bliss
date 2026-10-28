import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import prisma from '../../../prisma/prisma.js';
import { AuthService } from '../../../services/auth.service';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { withAuth } from '../../../utils/withAuth.js';
import { requireTrustedOrigin } from '../../../utils/trustedOrigin.js';
import { isRecentAuth } from '../../../utils/recentAuth.js';
import { reauthenticate } from '../../../services/session.service.js';

/**
 * Confirm-identity step-up for the recent sign-in rule (#156, R19–R20).
 *
 * GET  /api/auth/reauth
 *   → 200 { recent: boolean, methods: ('password' | 'google')[] }
 *
 * POST /api/auth/reauth   Body: { password }
 *   → 200 { ok: true } + a new access cookie whose `auth_time` is now (the
 *     session's 15-day cap is unchanged)
 *   → 401 REAUTH_FAILED (wrong password; the session is left intact)
 *   → 400 NO_PASSWORD (Google-only account: repeat Google sign-in instead)
 *
 * Google step-up goes through the normal Google sign-in (google-token.js).
 * `/api/auth` is denylisted for integration keys.
 */

const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function methodsFor(user) {
  const methods = [];
  if (user.passwordHash) methods.push('password');
  if (googleConfigured() && user.provider === 'google') methods.push('google');
  return methods;
}

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    const limiter = req.method === 'POST' ? rateLimiters.signin : rateLimiters.session;
    limiter(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(StatusCodes.METHOD_NOT_ALLOWED).end(`Method ${req.method} Not Allowed`);
    return;
  }

  try {
    const user = await prisma.user.findFirst({
      where: { id: req.user.id, tenantId: req.user.tenantId },
      select: { id: true, tenantId: true, email: true, passwordHash: true, passwordSalt: true, provider: true },
    });
    if (!user) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'User not found' });
      return;
    }

    if (req.method === 'GET') {
      res.status(StatusCodes.OK).json({ recent: isRecentAuth(req.user), methods: methodsFor(user) });
      return;
    }

    if (!requireTrustedOrigin(req, res)) return;

    if (!user.passwordHash) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'This account has no password', code: 'NO_PASSWORD' });
      return;
    }

    const { password } = req.body || {};
    const valid = typeof password === 'string' && password !== ''
      && await AuthService.verifyPassword(password, user.passwordHash, user.passwordSalt);
    if (!valid) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Incorrect password', code: 'REAUTH_FAILED' });
      return;
    }

    await reauthenticate(req, res, { id: user.id, tenantId: user.tenantId, email: user.email });
    res.status(StatusCodes.OK).json({ ok: true });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Reauth error:', { message: error?.message });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to confirm identity' });
  }
});
