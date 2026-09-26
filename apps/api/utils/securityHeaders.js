/**
 * Security response headers applied to every route served by apps/api — the
 * only browser-facing service in the monorepo.
 *
 * No Content-Security-Policy. CSP is the one header that can silently break the
 * NextAuth sign-in page, the Sentry browser SDK and Plaid Link's iframe, and it
 * is deliberately out of scope here (PRD decision D7).
 */

/** Headers safe to send over any transport, on every response. */
export function buildSecurityHeaders() {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
}

export const HSTS_HEADER = {
  key: 'Strict-Transport-Security',
  value: 'max-age=31536000; includeSubDomains',
};

/**
 * The full `headers()` rule set for next.config.mjs.
 *
 * HSTS must never reach a self-hoster serving plain HTTP — the browser would
 * pin the host to HTTPS and lock them out of their own instance. So it is
 * gated, but **not on an environment variable**, and that distinction is the
 * whole point of this file.
 *
 * Next.js evaluates `headers()` at BUILD time and bakes the result into
 * `.next/routes-manifest.json`. It is never re-evaluated at runtime. An earlier
 * version of this gated HSTS on `process.env.NEXTAUTH_URL?.startsWith('https')`
 * — which reads correctly but is dead code in any container deployment, because
 * NEXTAUTH_URL is a *runtime* variable and is simply absent during
 * `docker build`. The header silently never shipped, and a unit test asserting
 * the function's return value passed the whole time because it exercised the
 * wrong layer.
 *
 * `has` matchers, by contrast, are compiled into the manifest as conditions and
 * evaluated per request by the router. Gating on `x-forwarded-proto` is also
 * more truthful than any config value: it reflects how the request actually
 * arrived rather than how someone declared a URL.
 *
 * Known limitation: a deployment terminating TLS directly in Node, with no
 * proxy setting `x-forwarded-proto`, will not receive HSTS. That fails safe —
 * a missing HSTS header is a smaller problem than pinning a plain-HTTP
 * self-hoster to a scheme they cannot serve. Every platform deployment
 * (Railway, Vercel, nginx, Cloudflare, Traefik) sets the header.
 *
 * @returns {Array<object>} rules for `nextConfig.headers()`
 */
export function buildHeaderRules() {
  return [
    {
      source: '/(.*)',
      headers: buildSecurityHeaders(),
    },
    {
      source: '/(.*)',
      has: [{ type: 'header', key: 'x-forwarded-proto', value: 'https' }],
      headers: [HSTS_HEADER],
    },
  ];
}

export default buildHeaderRules;
