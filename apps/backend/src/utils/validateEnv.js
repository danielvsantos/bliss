const logger = require('./logger');

const UNSAFE_DEFAULTS = ['your-default-api-key', 'your-secret-key', 'changeme'];

const SUPPORTED_LLM_PROVIDERS = ['gemini', 'openai', 'anthropic'];
const EMBEDDING_CAPABLE_PROVIDERS = ['gemini', 'openai'];

const PROVIDER_KEY_VAR = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/**
 * Validate multi-LLM provider configuration.
 *
 * Writes into `errors` (fatal) and `warnings` (non-fatal) arrays. The caller
 * decides whether to throw based on NODE_ENV.
 *
 * Rules:
 *   - LLM_PROVIDER, if set, must be one of gemini | openai | anthropic.
 *   - EMBEDDING_PROVIDER, if set, must be gemini | openai. Anthropic is
 *     rejected because it has no embedding API.
 *   - LLM_PROVIDER=anthropic requires EMBEDDING_PROVIDER to be explicitly set
 *     (to gemini or openai).
 *   - The API key matching LLM_PROVIDER is warned-if-missing (graceful
 *     degradation, matches the existing GEMINI_API_KEY behaviour).
 *   - The API key matching EMBEDDING_PROVIDER (when different from the
 *     primary) is a hard error — the operator explicitly asked for it.
 */
function validateLlmConfig({ errors, warnings }) {
  const primary = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const explicitEmbedding = process.env.EMBEDDING_PROVIDER;
  const embedding = (explicitEmbedding || primary).toLowerCase();

  if (!SUPPORTED_LLM_PROVIDERS.includes(primary)) {
    errors.push(
      `LLM_PROVIDER="${primary}" is invalid. Supported: ${SUPPORTED_LLM_PROVIDERS.join(', ')}`
    );
    return;
  }

  // If primary=anthropic and embedding was defaulted (not explicitly set), the
  // operator omitted a required value. Emit the specific guidance so they know
  // they need to add EMBEDDING_PROVIDER rather than the generic "anthropic is
  // not an embedding provider" message.
  if (primary === 'anthropic' && !explicitEmbedding) {
    errors.push(
      'LLM_PROVIDER=anthropic requires EMBEDDING_PROVIDER to be set explicitly ' +
        '(to "gemini" or "openai"), because Anthropic has no embedding API.'
    );
    return;
  }

  if (embedding === 'anthropic') {
    errors.push(
      'EMBEDDING_PROVIDER cannot be "anthropic" — Anthropic has no embedding API. ' +
        'Set EMBEDDING_PROVIDER to "gemini" or "openai".'
    );
    return;
  }

  if (!EMBEDDING_CAPABLE_PROVIDERS.includes(embedding)) {
    errors.push(
      `EMBEDDING_PROVIDER="${embedding}" is invalid. Supported: ${EMBEDDING_CAPABLE_PROVIDERS.join(', ')}`
    );
    return;
  }

  // Primary-provider key: warn-if-missing (graceful degradation).
  const primaryKeyVar = PROVIDER_KEY_VAR[primary];
  if (!process.env[primaryKeyVar]) {
    warnings.push(
      `${primaryKeyVar} not set — AI classification and insights will be unavailable ` +
        `(LLM_PROVIDER=${primary}).`
    );
  }

  // Embedding-provider key (only when it differs from the primary): hard error.
  // The operator explicitly opted in to a second provider.
  if (embedding !== primary) {
    const embeddingKeyVar = PROVIDER_KEY_VAR[embedding];
    if (!process.env[embeddingKeyVar]) {
      errors.push(
        `${embeddingKeyVar} is required when EMBEDDING_PROVIDER=${embedding} ` +
          '(you opted in explicitly).'
      );
    }
  }
}

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

  // ─── LLM provider configuration ──────────────────────────────────────────
  validateLlmConfig({ errors, warnings });

  // ─── Optional integrations ───────────────────────────────────────────────
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

module.exports = {
  validateEnv,
  // Exported for test isolation
  validateLlmConfig,
  SUPPORTED_LLM_PROVIDERS,
  EMBEDDING_CAPABLE_PROVIDERS,
  PROVIDER_KEY_VAR,
};
