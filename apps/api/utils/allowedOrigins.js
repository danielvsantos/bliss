/**
 * Browser origins the API trusts. Driven by the existing FRONTEND_URL env var;
 * in non-production, localhost dev servers are added automatically so local
 * development works without any extra configuration.
 *
 * Shared by the CORS middleware (utils/cors.js) and the session Origin guard
 * (utils/trustedOrigin.js, #156), so the two can never disagree.
 * @returns {string[]}
 */
export function allowedOrigins() {
  const origins = [process.env.FRONTEND_URL].filter(Boolean);
  if (process.env.NODE_ENV !== 'production') {
    origins.push('http://localhost:8080', 'http://localhost:3000');
  }
  return origins;
}
