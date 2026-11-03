import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { clientIp } from './clientIp.js';
import { setCorsHeaders } from './cors.js';

export const RATE_LIMITED = 'RATE_LIMITED';

/** Default key: the real client IP (#78 R3, see utils/clientIp.js). */
export const ipKey = (req) => clientIp(req) || '127.0.0.1';

/**
 * Creates a rate limiter middleware with given options.
 *
 * Every 429 body is `{ error, code: 'RATE_LIMITED' }`, and the 429 carries the
 * same CORS headers a normal response would (#78 D8): routes call the limiter
 * before `cors()`, and without them a cross-origin SPA sees a CORS error
 * instead of the 429. CORS preflights (`OPTIONS`) are never counted.
 *
 * @param {Object} options
 * @param {number} options.max - Maximum number of requests allowed per window.
 * @param {number} options.windowMs - Time frame for rate limiting in milliseconds.
 * @param {string} [options.message] - Custom error message on exceeding the limit.
 * @param {Function} [options.keyGenerator] - Custom key (default: client IP).
 * @param {boolean} [options.skipSuccessfulRequests] - Only count failures.
 * @returns {Function} Express middleware
 */
export const createRateLimiter = (options = {}) => {
  const windowMs = options.windowMs || 5 * 60 * 1000; // default 5 minutes
  const max = options.max || 100;                     // default 100 requests per window
  const message = options.message || 'Too Many Requests. Please try again later.';

  return rateLimit({
    windowMs,
    max,
    message: { error: message, code: RATE_LIMITED },
    standardHeaders: true,  // Send RateLimit-* headers
    legacyHeaders: false,   // Disable X-RateLimit-* headers
    skipSuccessfulRequests: options.skipSuccessfulRequests === true,
    skip: (req) => req.method === 'OPTIONS',
    keyGenerator: options.keyGenerator || ipKey,
    handler: (req, res, _next, opts) => {
      setCorsHeaders(req, res);
      res.setHeader('Access-Control-Expose-Headers', 'RateLimit-Reset, Retry-After');
      res.status(opts.statusCode).json(opts.message);
    },
  });
};

/** Per-account signin key: never the plaintext email (#78 D3). */
export const accountKey = (email) =>
  `acct:${crypto.createHash('sha256').update(String(email ?? '')).digest('hex')}`;

/**
 * Pre-configured limiters for common use cases.
 * Can be imported directly or create custom ones.
 */
export const rateLimiters = {
    accounts: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }),   // 100 account API calls per 5 min
    analytics: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }),  // 100 analytics calls per 5 min
    assetprice: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }),  // 100 asset price API calls per 5 min
    banks: createRateLimiter({ max: 10, windowMs: 5 * 60 * 1000 }),      // 10 analytics calls per 5 min
    categories: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }), // 100 category API calls per 5 min
    countries: createRateLimiter({ max: 10, windowMs: 5 * 60 * 1000 }),  // 10 country calls per 5 min
    currencies: createRateLimiter({ max: 10, windowMs: 5 * 60 * 1000 }),  // 10 currency calls per 5 min
    currencyrates: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }),  // 100 currency rate calls per 5 min
    portfolio: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }),  // 100 portfolio API calls per 5 min
    session: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }),   // 100 session checks per 5 min
    signin: createRateLimiter({ max: 5, windowMs: 5 * 60 * 1000 }),       // 5 logins per 5 min
    // Per-account signin throttle (#78 D3): failures only, keyed on a hash of
    // the normalised email (req.signinEmail, set by signin.js), so rotating IPs
    // can't keep guessing one account.
    signinAccount: createRateLimiter({
      max: 10,
      windowMs: 15 * 60 * 1000,
      skipSuccessfulRequests: true,
      keyGenerator: (req) => accountKey(req.signinEmail),
    }),
    // Step-up password check (#78 R11): per user, not the signin bucket.
    reauth: createRateLimiter({
      max: 5,
      windowMs: 5 * 60 * 1000,
      keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : ipKey(req)),
    }),
    // Sign-out (#78 R11): its own roomy bucket so sign-outs never lock out sign-in.
    signout: createRateLimiter({ max: 30, windowMs: 5 * 60 * 1000 }),
    // Session refresh (#156): one per device every 15 min plus tab/resume
    // bursts; a household behind one NAT must never hit it (a 429 here is a
    // forced sign-in), hence its own, roomier limiter.
    refresh: createRateLimiter({ max: 60, windowMs: 5 * 60 * 1000 }),
    signup: createRateLimiter({ max: 5, windowMs: 5 * 60 * 1000 }),      // 5 signups per 5 min
    tags: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }), // 100 tag  per 5 min
    subscriptions: createRateLimiter({ max: 120, windowMs: 5 * 60 * 1000 }), // 120 subscriptions API calls per 5 min (reads + row actions)
    tenants: createRateLimiter({ max: 10, windowMs: 5 * 60 * 1000 }),     // 10 tenants per 5 min
    transactions: createRateLimiter({ max: 300, windowMs: 5 * 60 * 1000 }), // 300 transactions fetches
    users: createRateLimiter({ max: 20, windowMs: 5 * 60 * 1000 }),     // 20 user per 5 min
    enableBanking: createRateLimiter({ max: 60, windowMs: 5 * 60 * 1000 }), // 60 Enable Banking calls per 5 min (#132)
    enableBankingCredentials: createRateLimiter({ max: 20, windowMs: 5 * 60 * 1000 }), // 20 credential calls per 5 min (#148)
    etoro: createRateLimiter({ max: 60, windowMs: 5 * 60 * 1000 }), // 60 eToro connection calls per 5 min (#143)


  openai: createRateLimiter({ max: 20, windowMs: 5 * 60 * 1000 }),     // 20 chats jobs per 5 min

  // Smart Import endpoints
  importsDetect: createRateLimiter({ max: 30, windowMs: 5 * 60 * 1000 }),   // 30 detect calls per 5 min
  importsUpload: createRateLimiter({ max: 10, windowMs: 5 * 60 * 1000 }),   // 10 uploads per 5 min
  importsRead: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }),    // 100 reads per 5 min
  importsAdapters: createRateLimiter({ max: 30, windowMs: 5 * 60 * 1000 }), // 30 adapter calls per 5 min

  // Plaid Review endpoints
  plaidReview: createRateLimiter({ max: 150, windowMs: 5 * 60 * 1000 }),    // 150 review calls per 5 min (reads + updates)

  // Auth - sensitive operations
  changePassword: createRateLimiter({ max: 3, windowMs: 15 * 60 * 1000 }),  // 3 attempts per 15 min

  // Admin Maintenance — rebuild triggers are heavy; status polls are cheap.
  // Conservative cap on triggers prevents thrash against the single-flight lock.
  // Status endpoint is polled every ~5s by the UI, so 300/5min = 1/sec headroom.
  rebuildTrigger: createRateLimiter({ max: 20, windowMs: 5 * 60 * 1000 }),  // 20 triggers per 5 min
  rebuildStatus:  createRateLimiter({ max: 300, windowMs: 5 * 60 * 1000 }), // 300 polls per 5 min

  // Processing status (#100): polled every ~5 s while work is in flight, per
  // visible tab. 600 / 5 min covers two busy tabs (2 × 60) plus the MCP tool.
  activity: createRateLimiter({ max: 600, windowMs: 5 * 60 * 1000 }),

  // Integrations & API tokens management (admin only, #84)
  integrations: createRateLimiter({ max: 30, windowMs: 5 * 60 * 1000 }),   // 30 calls per 5 min
  // OAuth for the MCP server (#89): discovery, authorize, token, consent — and client registration.
  oauth: createRateLimiter({ max: 60, windowMs: 5 * 60 * 1000 }),
  oauthRegister: createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000 }),

};