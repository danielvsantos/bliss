import { allowedOrigins } from './allowedOrigins.js';

/**
 * Sets the CORS response headers. `Access-Control-Allow-Origin` and
 * `-Credentials` are only added for an allow-listed origin. Shared by `cors()`
 * and the rate limiter's 429 handler (#78 D8), so a 429 stays readable by the
 * SPA in a cross-origin deployment.
 */
export function setCorsHeaders(req, res) {
  const allowed = allowedOrigins();

  const origin = req.headers.origin;

  // Only set Access-Control-Allow-Origin if origin is in our allowed list
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Only set credentials header if we're allowing the origin
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Required headers for preflight requests
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // Allowed HTTP methods
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
}

// Middleware to handle CORS
export function cors(req, res) {
  setCorsHeaders(req, res);

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}
