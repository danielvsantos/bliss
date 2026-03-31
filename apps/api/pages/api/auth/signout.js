import { StatusCodes } from 'http-status-codes';
import { cors } from '../../../utils/cors.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import * as Sentry from '@sentry/nextjs';
import { clearAuthCookie } from '../../../utils/cookieUtils.js';
import jwt from 'jsonwebtoken';
import { addToDenylist } from '../../../utils/denylist.js';

export default async function handler(req, res) {
  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.signin(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  // Handle CORS
  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(StatusCodes.METHOD_NOT_ALLOWED).end(`Method ${req.method} Not Allowed`);
    return;
  }

  try {
    // Revoke the current token by adding its jti to the denylist
    const token = req.cookies?.token;
    if (token) {
      try {
        const decoded = jwt.decode(token);
        if (decoded?.jti && decoded?.exp) {
          const remainingTtl = decoded.exp - Math.floor(Date.now() / 1000);
          if (remainingTtl > 0) {
            await addToDenylist(decoded.jti, remainingTtl);
          }
        }
      } catch {
        // Non-fatal: if we can't decode/revoke, we still clear the cookie
      }
    }

    // Clear the HttpOnly auth cookie so the browser discards it immediately.
    clearAuthCookie(res);
    res.status(StatusCodes.OK).json({ message: 'Signed out successfully' });
  } catch (error) {
    Sentry.captureException(error);
    console.error('Signout error:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Sign out failed',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}
