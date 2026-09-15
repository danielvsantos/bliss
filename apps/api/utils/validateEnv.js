const UNSAFE_DEFAULTS = ['your-default-api-key', 'your-secret-key', 'changeme'];

// Minimum length for the four secrets that guard everything else. Length only —
// no entropy heuristic, which produces false negatives on legitimately random
// strings and would be a boot-time landmine on a running instance.
// scripts/setup.sh generates 48/48/48/32, so real installs pass.
// Keep in sync with apps/backend/src/utils/validateEnv.js.
export const MIN_SECRET_LENGTH = 32;

/**
 * Push a length error/warning for a secret that is present but too short.
 * Missing values are reported separately by the caller.
 */
function checkSecretLength(name, value, errors) {
  if (value && value.length < MIN_SECRET_LENGTH) {
    errors.push(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters (got ${value.length}). ` +
        'Generate one with: openssl rand -base64 48'
    );
  }
}

/**
 * Validates required environment variables at startup.
 * In production: throws on missing critical vars.
 * In development: logs warnings.
 */
export function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  // ─── Critical (required in all environments) ─────────────────────────────
  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL is required');
  }

  const jwtSecret = process.env.JWT_SECRET_CURRENT;
  if (!jwtSecret) {
    errors.push('JWT_SECRET_CURRENT is required');
  } else if (isProduction && UNSAFE_DEFAULTS.includes(jwtSecret)) {
    errors.push('JWT_SECRET_CURRENT must not use a default value in production');
  }

  const encryptionSecret = process.env.ENCRYPTION_SECRET;
  if (!encryptionSecret) {
    errors.push('ENCRYPTION_SECRET is required');
  }

  const apiKey = process.env.INTERNAL_API_KEY;
  if (!apiKey) {
    errors.push('INTERNAL_API_KEY is required');
  } else if (isProduction && UNSAFE_DEFAULTS.includes(apiKey)) {
    errors.push('INTERNAL_API_KEY must not use a default value in production');
  }

  const nextAuthSecret = process.env.NEXTAUTH_SECRET;
  if (!nextAuthSecret) {
    errors.push('NEXTAUTH_SECRET is required');
  }

  // ─── Secret strength ─────────────────────────────────────────────────────
  checkSecretLength('ENCRYPTION_SECRET', encryptionSecret, errors);
  checkSecretLength('JWT_SECRET_CURRENT', jwtSecret, errors);
  checkSecretLength('NEXTAUTH_SECRET', nextAuthSecret, errors);
  checkSecretLength('INTERNAL_API_KEY', apiKey, errors);

  // ─── Optional (warn if missing) ──────────────────────────────────────────
  if (!process.env.BACKEND_URL) {
    warnings.push('BACKEND_URL not set — backend service communication will fail');
  }
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    warnings.push('Plaid credentials not set — Plaid integration will be unavailable');
  }
  if (!process.env.REDIS_URL) {
    warnings.push('REDIS_URL not set — JWT denylist is disabled (tokens cannot be revoked)');
  }
  if (!process.env.SENTRY_DSN) {
    warnings.push('SENTRY_DSN not set — error tracking will be disabled');
  }

  // ─── Report ──────────────────────────────────────────────────────────────
  for (const w of warnings) {
    console.warn(`[env] ${w}`);
  }

  if (errors.length > 0) {
    const msg = `Environment validation failed:\n  - ${errors.join('\n  - ')}`;
    if (isProduction) {
      throw new Error(msg);
    }
    console.warn(`[env] ${msg}`);
  }
}
