import { getToken } from 'next-auth/jwt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../../prisma/prisma.js';
import * as Sentry from '@sentry/nextjs';
import { setAuthCookie } from '../../../utils/cookieUtils.js';

const JWT_SECRET = process.env.JWT_SECRET_CURRENT || process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET_CURRENT or JWT_SECRET must be set in environment variables');
}
const TOKEN_EXPIRY = '24h';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

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

    // Issue a custom JWT identical in shape to the one from signin.js
    const token = jwt.sign(
      {
        jti: uuidv4(),
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
      },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    const isNew = nextAuthToken.isNew ?? false;

    // Set HttpOnly cookie and redirect to frontend (no token in URL)
    setAuthCookie(res, token);
    return res.redirect(`${FRONTEND_URL}/auth/callback?isNew=${isNew}`);
  } catch (error) {
    console.error('Google token exchange error:', error);
    Sentry.captureException(error);
    return res.redirect(`${FRONTEND_URL}/auth?error=oauth_failed`);
  }
}
