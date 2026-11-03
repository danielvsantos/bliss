import { getToken } from 'next-auth/jwt';
import prisma from '../../../prisma/prisma.js';
import * as Sentry from '@sentry/nextjs';
import { findLiveSession, reauthenticate } from '../../../services/session.service.js';
import { clearNextAuthCookies } from '../../../utils/cookieUtils.js';
import { googleExchangeRejection } from '../../../utils/googleExchange.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

/**
 * Exchanges the NextAuth (Google) session for a Bliss session and redirects to
 * the SPA. Every Google sign-in is a real sign-in (#156):
 *   - the browser already holds a live session of the same user (the Google
 *     step-up for a recent sign-in) → that session's `authenticatedAt` moves
 *     to now; its 15-day cap is unchanged;
 *   - otherwise → a new session (access + refresh cookies); a live session of
 *     a different user on this browser is revoked.
 *
 * The NextAuth cookie is single-use (#78 R2): it is refused when its Google
 * sign-in is older than the 5-min window, older than the user's
 * `sessionsRevokedAt` (password change, sign out other devices), or already
 * exchanged (a UserSession of the user was authenticated at or after it). It
 * is cleared on every outcome.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  try {
    // Read the NextAuth session JWT from the cookie
    const nextAuthToken = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

    // Whatever happens next, this cookie has done its job.
    clearNextAuthCookies(res);

    if (!nextAuthToken || !nextAuthToken.id) {
      return res.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
    }

    // Look up the user in the database
    const user = await prisma.user.findUnique({
      where: { id: nextAuthToken.id },
      select: { id: true, email: true, tenantId: true, name: true, sessionsRevokedAt: true },
    });

    if (!user) {
      return res.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
    }

    const latest = await prisma.userSession.findFirst({
      where: { tenantId: user.tenantId, userId: user.id },
      orderBy: { authenticatedAt: 'desc' },
      select: { authenticatedAt: true },
    });
    const rejection = googleExchangeRejection(nextAuthToken, {
      sessionsRevokedAt: user.sessionsRevokedAt,
      lastAuthenticatedAt: latest?.authenticatedAt ?? null,
    });
    if (rejection) {
      console.warn(JSON.stringify({ event: 'google_exchange_rejected', reason: rejection, userId: user.id }));
      return res.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
    }

    const { sessionsRevokedAt: _revokedAt, ...sessionUser } = user;
    const session = await findLiveSession(req);
    await reauthenticate(req, res, sessionUser, { session });

    const isNew = nextAuthToken.isNew ?? false;

    // Cookies are set; redirect to the frontend (no token in URL)
    return res.redirect(`${FRONTEND_URL}/auth/callback?isNew=${isNew}`);
  } catch (error) {
    console.error('Google token exchange error:', error);
    Sentry.captureException(error);
    return res.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
  }
}
