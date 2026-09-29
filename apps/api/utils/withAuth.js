import jwt from 'jsonwebtoken';
import prisma from '../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import { isRevoked } from './denylist.js';
import { cors } from './cors.js';
import { requestIp, touchLastUsed, verifyApiKey } from './apiKeys.js';
import {
  NOT_AVAILABLE_TO_INTEGRATIONS,
  effectiveRole,
  extractIntegrationToken,
  isDeniedForIntegration,
  normalizeApiPath,
  redactIntegrationTokens,
} from './integrationPolicy.js';

const TOKEN_ERROR_MESSAGES = {
  TOKEN_INVALID: 'Invalid API token',
  TOKEN_EXPIRED: 'API token has expired',
  TOKEN_REVOKED: 'API token has been revoked',
};

/**
 * One structured line per integration-token request (#84). IDs only — never
 * the token, its hash, or the request body.
 */
function logIntegrationRequest(req, res, key, integration, route) {
  console.info(JSON.stringify({
    event: 'integration_request',
    tenantId: key.tenantId,
    integrationId: integration.id,
    apiKeyId: key.id,
    method: req.method,
    route,
    status: res.statusCode,
  }));
}

/**
 * Integration-token branch of withAuth. Cookies are ignored: a request that
 * presents a `bliss_` bearer token is authenticated by that token only.
 */
async function authenticateIntegration(token, req, res, handler, { optional, requireRole }) {
  let result;
  try {
    result = await verifyApiKey(token);
  } catch (err) {
    console.error('withAuth: API key lookup failed', { message: redactIntegrationTokens(err?.message) });
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Authentication error' });
  }

  if (!result.ok) {
    if (optional) {
      req.user = null;
      return handler(req, res);
    }
    return res.status(StatusCodes.UNAUTHORIZED).json({
      error: TOKEN_ERROR_MESSAGES[result.code],
      code: result.code,
    });
  }

  const { apiKey, integration, user } = result;
  const route = normalizeApiPath(req.url);

  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    logIntegrationRequest(req, res, apiKey, integration, route);
  };
  const hasFinishEvent = typeof res.once === 'function';
  if (hasFinishEvent) res.once('finish', log);

  touchLastUsed(apiKey, requestIp(req));

  const deny = (status, body) => {
    res.status(status).json(body);
    if (!hasFinishEvent) log();
    return res;
  };

  if (isDeniedForIntegration(req.url, req.method)) {
    return deny(StatusCodes.FORBIDDEN, {
      error: 'This endpoint is not available to integration tokens',
      code: NOT_AVAILABLE_TO_INTEGRATIONS,
    });
  }

  const role = effectiveRole(user.role, integration.accessLevel);

  // Same rule as viewer users: read-only tokens cannot mutate anything.
  if (role === 'viewer' && req.method !== 'GET') {
    return deny(StatusCodes.FORBIDDEN, {
      error: 'Read-only integration',
      code: 'READ_ONLY_INTEGRATION',
    });
  }

  // Tokens are never admin, so admin-only routes always refuse them here.
  if (requireRole && role !== requireRole) {
    return deny(StatusCodes.FORBIDDEN, { error: 'Insufficient permissions' });
  }

  req.user = {
    id: user.id,
    tenantId: apiKey.tenantId,
    email: user.email,
    role,
    authType: 'integration',
    integrationId: integration.id,
    apiKeyId: apiKey.id,
  };

  const out = await handler(req, res);
  if (!hasFinishEvent) log();
  return out;
}

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
 * Integration tokens (`Authorization: Bearer bliss_…`, #84) are checked first
 * and bypass the JWT path entirely. They hydrate req.user as the creating
 * admin with a capped role (viewer | member, never admin) plus
 * `authType: 'integration'`, `integrationId` and `apiKeyId`, and are refused
 * on the routes listed in utils/integrationPolicy.js.
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

    const integrationToken = extractIntegrationToken(req.headers?.authorization);
    if (integrationToken) {
      return authenticateIntegration(integrationToken, req, res, handler, { optional, requireRole });
    }

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
