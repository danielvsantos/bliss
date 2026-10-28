/**
 * Cookie utilities for HttpOnly JWT authentication.
 *
 * Cookie attributes:
 * - HttpOnly   — inaccessible to JavaScript (XSS defence)
 * - Secure     — HTTPS only (always set when SameSite=None, also in production)
 * - SameSite   — "None" when cross-origin (FRONTEND_URL differs from API origin),
 *                "Lax" when same-origin
 * - Domain     — configurable via COOKIE_DOMAIN env var (e.g., ".blissfinance.co"
 *                for cross-subdomain sharing). Omitted when not set (localhost).
 * - Path       — `/` for the access cookie (every API request); `/api/auth`
 *                for the refresh cookie, so it only travels to the auth routes
 * - Max-Age    — access: matches the 15-minute JWT; refresh: the session's
 *                idle timeout, capped at its absolute expiry (#156)
 *
 * Two cookies are set on the same response (sign-in, refresh), so every
 * helper appends to `Set-Cookie` instead of replacing it.
 */

export const ACCESS_COOKIE = 'token';
export const REFRESH_COOKIE = 'bliss_rt';
export const REFRESH_COOKIE_PATH = '/api/auth';
const TOKEN_MAX_AGE = 15 * 60; // 15 minutes in seconds — the access JWT TTL (#156)

/**
 * Determine if the frontend and API are on different origins.
 * When they are, we need SameSite=None + Secure for cookies to be sent
 * on cross-origin XHR/fetch requests.
 */
function isCrossOrigin() {
  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) return false;

  try {
    const frontend = new URL(frontendUrl);
    // If the API is at localhost:3000 and frontend at localhost:8080, that's cross-origin
    const apiHost = process.env.NEXTAUTH_URL
      ? new URL(process.env.NEXTAUTH_URL).host
      : null;
    return apiHost ? frontend.host !== apiHost : false;
  } catch {
    return false;
  }
}

function buildCookieParts(nameValue, maxAge, path = '/') {
  const crossOrigin = isCrossOrigin();
  const cookieDomain = process.env.COOKIE_DOMAIN; // e.g., ".blissfinance.co"

  const parts = [
    nameValue,
    'HttpOnly',
    `Path=${path}`,
    `Max-Age=${maxAge}`,
  ];

  if (crossOrigin) {
    // Cross-origin requires SameSite=None + Secure for the browser to send
    // the cookie on XHR/fetch requests from a different origin.
    parts.push('SameSite=None');
    parts.push('Secure');
  } else {
    parts.push('SameSite=Lax');
    // Only add Secure in production when not cross-origin (same-origin HTTPS)
    if (process.env.NODE_ENV === 'production' && !process.env.NEXTAUTH_URL?.startsWith('http://')) {
      parts.push('Secure');
    }
  }

  if (cookieDomain) {
    parts.push(`Domain=${cookieDomain}`);
  }

  return parts.join('; ');
}

/**
 * Append one cookie to the response's `Set-Cookie` header, keeping any cookie
 * set earlier on the same response.
 * @param {import('next').NextApiResponse} res
 * @param {string} cookie
 */
export function appendSetCookie(res, cookie) {
  const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  if (existing === undefined || existing === null || existing === '') {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  const list = Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

/**
 * Set the authentication (access) cookie on the response.
 * @param {import('next').NextApiResponse} res
 * @param {string} token — signed JWT string
 */
export function setAuthCookie(res, token) {
  appendSetCookie(res, buildCookieParts(`${ACCESS_COOKIE}=${token}`, TOKEN_MAX_AGE));
}

/**
 * Clear the authentication (access) cookie (immediate expiry).
 * @param {import('next').NextApiResponse} res
 */
export function clearAuthCookie(res) {
  appendSetCookie(res, buildCookieParts(`${ACCESS_COOKIE}=`, 0));
}

/**
 * Set the refresh cookie (#156): HttpOnly, `Path=/api/auth`, same
 * SameSite/Secure/Domain rules as the access cookie.
 * @param {import('next').NextApiResponse} res
 * @param {string} value — `<sessionId>.<secret>`
 * @param {number} maxAge — seconds
 */
export function setRefreshCookie(res, value, maxAge) {
  appendSetCookie(
    res,
    buildCookieParts(`${REFRESH_COOKIE}=${value}`, Math.max(0, Math.floor(maxAge)), REFRESH_COOKIE_PATH),
  );
}

/**
 * Clear the refresh cookie (immediate expiry).
 * @param {import('next').NextApiResponse} res
 */
export function clearRefreshCookie(res) {
  appendSetCookie(res, buildCookieParts(`${REFRESH_COOKIE}=`, 0, REFRESH_COOKIE_PATH));
}

/**
 * Clear both session cookies.
 * @param {import('next').NextApiResponse} res
 */
export function clearSessionCookies(res) {
  clearAuthCookie(res);
  clearRefreshCookie(res);
}
