import { getToken } from 'next-auth/jwt';
import prisma from '../../../prisma/prisma.js';
import * as Sentry from '@sentry/nextjs';
import { findLiveSession, reauthenticate } from '../../../services/session.service.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

/**
 * Exchanges the NextAuth (Google) session for a Bliss session and redirects to
 * the SPA. Every Google sign-in is a real sign-in (#156):
 *   - the browser already holds a live session of the same user (the Google
 *     step-up for a recent sign-in) → that session's `authenticatedAt` moves
 *     to now; its 15-day cap is unchanged;
 *   - otherwise → a new session (access + refresh cookies); a live session of
 *     a different user on this browser is revoked.
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

    if (!nextAuthToken || !nextAuthToken.id) {
      return res.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
    }

    // Look up the user in the database
    const user = await prisma.user.findUnique({
      where: { id: nextAuthToken.id },
      select: { id: true, email: true, tenantId: true, name: true },
    });

    if (!user) {
      return res.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
    }

    const session = await findLiveSession(req);
    await reauthenticate(req, res, user, { session });

    const isNew = nextAuthToken.isNew ?? false;

    // Cookies are set; redirect to the frontend (no token in URL)
    return res.redirect(`${FRONTEND_URL}/auth/callback?isNew=${isNew}`);
  } catch (error) {
    console.error('Google token exchange error:', error);
    Sentry.captureException(error);
    return res.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
  }
}
