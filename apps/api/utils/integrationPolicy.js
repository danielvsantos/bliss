/**
 * Integration token access policy (#84).
 *
 * Integration tokens (`Authorization: Bearer bliss_…`) never carry their own
 * permission model. They resolve to a req.user with a capped role — `viewer`
 * for READ_ONLY, `member` for READ_WRITE, never `admin` — so every existing
 * viewer rule and admin check applies to them unchanged. This module adds the
 * one thing roles cannot express: a small central denylist of non-admin routes
 * a token must never reach (sessions, user profiles, token management, the
 * Plaid connection lifecycle, and account/category/tenant writes).
 *
 * PURE MODULE: no Node built-ins, no Prisma. It is imported both by withAuth
 * (Node runtime) and by the root Next.js middleware.js (Edge runtime).
 *
 * Every new route under pages/api must be classified in
 * __tests__/unit/middleware/integrationRouteMatrix.test.ts, which fails when a
 * route has no asserted outcome for integration tokens.
 */

export const TOKEN_PREFIX = 'bliss_';

export const INTEGRATION_ACCESS_LEVELS = ['READ_ONLY', 'READ_WRITE'];

export const NOT_AVAILABLE_TO_INTEGRATIONS = 'NOT_AVAILABLE_TO_INTEGRATIONS';

/**
 * Denied path prefixes, matched on whole path segments. `methods: 'ALL'`
 * blocks every method; `methods: 'NON_GET'` blocks everything except GET
 * (and HEAD, which Next serves through the GET handler).
 */
export const INTEGRATION_DENYLIST = Object.freeze([
  // Sessions, sign-in, password changes.
  { prefix: '/api/auth', methods: 'ALL' },
  // A member can edit their own profile; a token must not edit the creating admin's.
  { prefix: '/api/users', methods: 'ALL' },
  // Tokens cannot manage tokens.
  { prefix: '/api/integrations', methods: 'ALL' },
  // Plaid connection lifecycle. The review queue (/api/plaid/transactions/*)
  // stays available to read-write tokens.
  { prefix: '/api/plaid/create-link-token', methods: 'ALL' },
  { prefix: '/api/plaid/exchange-public-token', methods: 'ALL' },
  { prefix: '/api/plaid/disconnect', methods: 'ALL' },
  { prefix: '/api/plaid/rotate-token', methods: 'ALL' },
  { prefix: '/api/plaid/items/hard-delete', methods: 'ALL' },
  { prefix: '/api/plaid/resync', methods: 'ALL' },
  { prefix: '/api/plaid/sync-accounts', methods: 'ALL' },
  { prefix: '/api/plaid/fetch-historical', methods: 'ALL' },
  // PATCH resets connection status after re-auth — lifecycle, not data.
  { prefix: '/api/plaid/items', methods: 'NON_GET' },
  // No account/category/tenant writes for tokens.
  { prefix: '/api/accounts', methods: 'NON_GET' },
  { prefix: '/api/categories', methods: 'NON_GET' },
  { prefix: '/api/tenants', methods: 'NON_GET' },
]);

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Normalise a request URL to a comparable API path: query string and fragment
 * removed, percent-decoded, lowercased, duplicate and trailing slashes
 * dropped, and `.` / `..` segments resolved. This closes the obvious bypasses
 * (`/api/Users`, `/api//users/`, `/api/%75sers`, `/api/x/../users`).
 *
 * @param {string|undefined|null} url
 * @returns {string}
 */
export function normalizeApiPath(url) {
  if (typeof url !== 'string' || url.length === 0) return '';

  let path = url.split('?')[0].split('#')[0];
  // Absolute URLs (some proxies) → keep only the pathname.
  const schemeMatch = path.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i);
  if (schemeMatch) path = path.slice(schemeMatch[0].length);

  const out = [];
  for (const raw of path.replace(/\\/g, '/').split('/')) {
    const segment = safeDecode(raw).toLowerCase();
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join('/')}`;
}

function matchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * @param {string} url     Raw request URL or path.
 * @param {string} method  HTTP method.
 * @returns {boolean} true when an integration token must be refused.
 */
export function isDeniedForIntegration(url, method) {
  const path = normalizeApiPath(url);
  // Fail closed: a token request whose path cannot be determined is refused.
  if (!path || path === '/') return true;

  const upper = String(method || 'GET').toUpperCase();
  const isRead = upper === 'GET' || upper === 'HEAD';

  return INTEGRATION_DENYLIST.some(({ prefix, methods }) => {
    if (!matchesPrefix(path, prefix)) return false;
    return methods === 'ALL' || !isRead;
  });
}

/**
 * Role a token acts with. READ_ONLY → viewer. READ_WRITE → member, unless the
 * creating user has since been demoted to viewer, in which case viewer: an
 * integration never exceeds its creator's current rights. Never `admin`.
 *
 * @param {string} creatorRole
 * @param {string} accessLevel
 * @returns {'viewer'|'member'}
 */
export function effectiveRole(creatorRole, accessLevel) {
  if (accessLevel !== 'READ_WRITE') return 'viewer';
  if (creatorRole === 'viewer') return 'viewer';
  return 'member';
}

const INTEGRATION_BEARER = /^bearer\s+(bliss_.*)$/i;

/**
 * Extract a Bliss integration token from an Authorization header. The scheme
 * is case-insensitive (RFC 7235); the token itself must start with `bliss_`.
 *
 * @param {string|undefined} authHeader
 * @returns {string|null} the raw token, or null when the header is not one.
 */
export function extractIntegrationToken(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const match = authHeader.match(INTEGRATION_BEARER);
  return match ? match[1] : null;
}

/**
 * @param {string|undefined} authHeader
 * @returns {boolean} true when the header carries a Bliss integration token.
 */
export function isIntegrationToken(authHeader) {
  return extractIntegrationToken(authHeader) !== null;
}

const TOKEN_IN_TEXT = /bliss_[A-Za-z0-9]{8}_[A-Za-z0-9]{8,}/g;

/**
 * Redact integration tokens from free text before it is logged.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactIntegrationTokens(text) {
  return String(text ?? '').replace(TOKEN_IN_TEXT, 'bliss_[redacted]');
}
