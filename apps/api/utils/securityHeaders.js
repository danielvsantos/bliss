/**
 * Security response headers applied to every route served by apps/api — the
 * only browser-facing service in the monorepo.
 *
 * No Content-Security-Policy. CSP is the one header that can silently break the
 * NextAuth sign-in page, the Sentry browser SDK and Plaid Link's iframe, and it
 * is deliberately out of scope here (PRD decision D7).
 *
 * @param {string} [nextAuthUrl] Value of NEXTAUTH_URL. HSTS is emitted only for
 *   an HTTPS deployment — sending it from a self-hosted plain-HTTP instance
 *   would pin the host to HTTPS in the browser and lock the operator out of
 *   their own installation. This is the same predicate used to gate
 *   SameSite=None cookies in pages/api/auth/[...nextauth].js, so the two gates
 *   can never disagree.
 * @returns {Array<{ key: string, value: string }>}
 */
export function buildSecurityHeaders(nextAuthUrl = process.env.NEXTAUTH_URL) {
  const isHttps = (nextAuthUrl || '').startsWith('https://');

  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ...(isHttps
      ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
      : []),
  ];
}

export default buildSecurityHeaders;
