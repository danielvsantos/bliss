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
 * - Path=/     — sent with every API request
 * - Max-Age    — matches the JWT expiry (24 hours)
 */

const TOKEN_MAX_AGE = 60 * 60 * 24; // 24 hours in seconds

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

function buildCookieParts(nameValue, maxAge) {
  const crossOrigin = isCrossOrigin();
  const cookieDomain = process.env.COOKIE_DOMAIN; // e.g., ".blissfinance.co"

  const parts = [
    nameValue,
    'HttpOnly',
    'Path=/',
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
 * Set the authentication cookie on the response.
 * @param {import('next').NextApiResponse} res
 * @param {string} token — signed JWT string
 */
export function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', buildCookieParts(`token=${token}`, TOKEN_MAX_AGE));
}

/**
 * Clear the authentication cookie (immediate expiry).
 * @param {import('next').NextApiResponse} res
 */
export function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', buildCookieParts('token=', 0));
}
