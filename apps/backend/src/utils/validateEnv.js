const logger = require('./logger');

const UNSAFE_DEFAULTS = ['your-default-api-key', 'your-secret-key', 'changeme'];

/**
 * Validates required environment variables at startup.
 * In production: throws on missing critical vars.
 * In development: logs warnings.
 */
function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  // ─── Critical (required in all environments) ─────────────────────────────
  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL is required');
  }
  if (!process.env.REDIS_URL) {
    errors.push('REDIS_URL is required');
  }

  // ─── Security-sensitive (must not use defaults in production) ─────────────
  const apiKey = process.env.INTERNAL_API_KEY;
  if (!apiKey) {
    errors.push('INTERNAL_API_KEY is required');
  } else if (isProduction && UNSAFE_DEFAULTS.includes(apiKey)) {
    errors.push('INTERNAL_API_KEY must not use a default value in production');
  }

  const encryptionSecret = process.env.ENCRYPTION_SECRET;
  if (!encryptionSecret) {
    errors.push('ENCRYPTION_SECRET is required');
  }

  // ─── Optional (warn if missing) ──────────────────────────────────────────
  if (!process.env.GEMINI_API_KEY) {
    warnings.push('GEMINI_API_KEY not set — AI classification will be unavailable');
  }
  if (!process.env.TWELVE_DATA_API_KEY) {
    warnings.push('TWELVE_DATA_API_KEY not set — stock price fetching will be unavailable');
  }
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    warnings.push('Plaid credentials not set — Plaid integration will be unavailable');
  }
  if (!process.env.SENTRY_DSN) {
    warnings.push('SENTRY_DSN not set — error tracking will be disabled');
  }

  // ─── Report ──────────────────────────────────────────────────────────────
  for (const w of warnings) {
    logger.warn(`[env] ${w}`);
  }

  if (errors.length > 0) {
    const msg = `Environment validation failed:\n  - ${errors.join('\n  - ')}`;
    if (isProduction) {
      throw new Error(msg);
    }
    logger.warn(`[env] ${msg}`);
  }
}

module.exports = { validateEnv };
