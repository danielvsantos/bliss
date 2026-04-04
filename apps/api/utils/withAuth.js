import jwt from 'jsonwebtoken';
import prisma from '../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import { isRevoked } from './denylist.js';
import { cors } from './cors.js';

/**
 * Centralized authentication middleware for Next.js API routes.
 *
 * Extracts the JWT from:
 *   1. req.cookies.token   (HttpOnly cookie — primary, post-Phase 2.2)
 *   2. Authorization header (Bearer <token> — fallback for backwards compat)
 *
 * On success: attaches req.user = { id, tenantId, email, role } and calls handler.
 * On failure: returns 401.
 *
 * @param {Function} handler          — The Next.js API handler to wrap
 * @param {Object}   [options]
 * @param {boolean}  [options.optional=false]    — If true, missing/invalid token is allowed (req.user will be null)
 * @param {string}   [options.requireRole]       — If set, user.role must equal this value or a 403 is returned
 * @returns {Function} Wrapped Next.js API handler
 */
export function withAuth(handler, { optional = false, requireRole } = {}) {
  return async function authWrapper(req, res) {
    // Handle CORS and OPTIONS preflight BEFORE any auth check.
    // This ensures preflight requests (which carry no cookies) always receive
    // the correct CORS headers and a 200 response, instead of a 401 from the
    // JWT check below. cors() returns true for OPTIONS (response already sent).
    if (cors(req, res)) return;

    // Support rolling secret rotation: try current secret first, fall back to previous
    const secrets = [
      process.env.JWT_SECRET_CURRENT,
      process.env.JWT_SECRET,           // backwards compat alias
      process.env.JWT_SECRET_PREVIOUS,
    ].filter(Boolean);

    if (secrets.length === 0) {
      console.error('withAuth: No JWT secret configured (JWT_SECRET_CURRENT or JWT_SECRET)');
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Server configuration error' });
    }

    // Extract token — cookie first, then Authorization header
    let token = req.cookies?.token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      if (optional) {
        req.user = null;
        return handler(req, res);
      }
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Authentication required' });
    }

    // Verify token against available secrets (supports rolling rotation)
    let decoded;
    for (const secret of secrets) {
      try {
        decoded = jwt.verify(token, secret);
        break;
      } catch {
        // Try next secret
      }
    }

    if (!decoded) {
      if (optional) {
        req.user = null;
        return handler(req, res);
      }
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid or expired token' });
    }

    // Check denylist (token revoked on sign-out)
    if (decoded.jti && await isRevoked(decoded.jti)) {
      if (optional) {
        req.user = null;
        return handler(req, res);
      }
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Token has been revoked' });
    }

    // Hydrate user from DB
    try {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, tenantId: true, email: true, role: true },
      });

      if (!user) {
        if (optional) {
          req.user = null;
          return handler(req, res);
        }
        return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'User not found' });
      }

      // Viewer role: read-only access (block all non-GET requests)
      if (user.role === 'viewer' && req.method !== 'GET') {
        return res.status(StatusCodes.FORBIDDEN).json({ error: 'Viewer accounts are read-only' });
      }

      // Role-based access control check
      if (requireRole && user.role !== requireRole) {
        return res.status(StatusCodes.FORBIDDEN).json({ error: 'Insufficient permissions' });
      }

      req.user = user;
      return handler(req, res);
    } catch (err) {
      console.error('withAuth: DB lookup failed', err);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Authentication error' });
    }
  };
}
