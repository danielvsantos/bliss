import rateLimit from 'express-rate-limit';

/**
 * Creates a rate limiter middleware with given options.
 * 
 * @param {Object} options
 * @param {number} options.max - Maximum number of requests allowed per window.
 * @param {number} options.windowMs - Time frame for rate limiting in milliseconds.
 * @param {string} [options.message] - Custom error message on exceeding the limit.
 * @returns {Function} Express middleware
 */
export const createRateLimiter = (options = {}) => {
  const windowMs = options.windowMs || 5 * 60 * 1000; // default 5 minutes
  const max = options.max || 100;                     // default 100 requests per window
  const message = options.message || 'Too Many Requests. Please try again later.';

  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,  // Send RateLimit-* headers
    legacyHeaders: false,   // Disable X-RateLimit-* headers
    keyGenerator: (req) => {
      // Get IP from various possible sources in Next.js
      const ip = 
        req.headers['x-real-ip'] ||
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.socket?.remoteAddress ||
        '127.0.0.1';  // Fallback for local development
      return ip;
    }
  });
};

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
    signup: createRateLimiter({ max: 5, windowMs: 5 * 60 * 1000 }),      // 5 signups per 5 min
    tags: createRateLimiter({ max: 100, windowMs: 5 * 60 * 1000 }), // 100 tag  per 5 min
    tenants: createRateLimiter({ max: 10, windowMs: 5 * 60 * 1000 }),     // 10 tenants per 5 min
    transactions: createRateLimiter({ max: 300, windowMs: 5 * 60 * 1000 }), // 300 transactions fetches
    users: createRateLimiter({ max: 20, windowMs: 5 * 60 * 1000 }),     // 20 user per 5 min


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

};