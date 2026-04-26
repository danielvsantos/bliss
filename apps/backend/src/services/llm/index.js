/**
 * LLM provider factory.
 *
 * Resolves the configured provider(s) at module load and exposes the same
 * four functions all consumers have always used:
 *
 *     generateEmbedding
 *     classifyTransaction
 *     generateInsightContent
 *     isRateLimitError
 *
 * Configuration is purely environment-driven (deployment-level, not per-tenant):
 *
 *   LLM_PROVIDER        — gemini | openai | anthropic   (default: gemini)
 *   EMBEDDING_PROVIDER  — gemini | openai               (default: LLM_PROVIDER)
 *
 * Anthropic does not provide an embedding API, so:
 *   • EMBEDDING_PROVIDER must be set to gemini or openai when LLM_PROVIDER=anthropic
 *   • EMBEDDING_PROVIDER=anthropic is always rejected
 *
 * Individual model overrides (EMBEDDING_MODEL, CLASSIFICATION_MODEL, INSIGHT_MODEL)
 * are honored inside each adapter.
 */

const logger = require('../../utils/logger');

const SUPPORTED_PROVIDERS = ['gemini', 'openai', 'anthropic'];
const EMBEDDING_CAPABLE_PROVIDERS = ['gemini', 'openai'];

/**
 * Load a named adapter module.
 * @private
 */
function loadAdapter(name) {
  switch (name) {
    case 'gemini':
      return require('./geminiAdapter');
    case 'openai':
      return require('./openaiAdapter');
    case 'anthropic':
      return require('./anthropicAdapter');
    default:
      throw new Error(
        `Unknown LLM provider "${name}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`
      );
  }
}

/**
 * Resolve primary and embedding adapters based on env vars.
 * Exported so tests can call it in isolation with a fresh module state.
 */
function resolveAdapters() {
  const primary = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const embedding = (process.env.EMBEDDING_PROVIDER || primary).toLowerCase();

  if (!SUPPORTED_PROVIDERS.includes(primary)) {
    throw new Error(
      `Invalid LLM_PROVIDER "${primary}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }

  if (embedding === 'anthropic') {
    throw new Error(
      'EMBEDDING_PROVIDER=anthropic is not supported (Anthropic has no embedding API). ' +
        'Set EMBEDDING_PROVIDER to "gemini" or "openai".'
    );
  }

  if (!EMBEDDING_CAPABLE_PROVIDERS.includes(embedding)) {
    throw new Error(
      `Invalid EMBEDDING_PROVIDER "${embedding}". Supported: ${EMBEDDING_CAPABLE_PROVIDERS.join(', ')}`
    );
  }

  // Anthropic primary requires an embedding provider to be explicitly wired up.
  // (This is a subset of the check above — if primary=anthropic and embedding=anthropic,
  //  the embedding check already threw. So this is just a guardrail for clarity.)
  if (primary === 'anthropic' && embedding === 'anthropic') {
    throw new Error(
      'LLM_PROVIDER=anthropic requires EMBEDDING_PROVIDER=gemini or openai ' +
        '(Anthropic has no embedding API).'
    );
  }

  const primaryAdapter = loadAdapter(primary);
  const embeddingAdapter = embedding === primary ? primaryAdapter : loadAdapter(embedding);

  logger.info(
    `LLM provider configured: primary=${primary}, embedding=${embedding}`
  );

  return { primary, embedding, primaryAdapter, embeddingAdapter };
}

// Resolve once at module load. Any misconfiguration crashes the process — this is
// intentional, because downstream code cannot function without a valid LLM.
const { primaryAdapter, embeddingAdapter } = resolveAdapters();

module.exports = {
  generateEmbedding: (text) => embeddingAdapter.generateEmbedding(text),
  classifyTransaction: (description, merchantName, categories, plaidCategory, options) =>
    primaryAdapter.classifyTransaction(description, merchantName, categories, plaidCategory, options),
  generateInsightContent: (prompt, options) => primaryAdapter.generateInsightContent(prompt, options),
  isRateLimitError: (err) => primaryAdapter.isRateLimitError(err),

  // Exposed for tests and operator tooling (regenerate-embeddings script etc.)
  resolveAdapters,
  SUPPORTED_PROVIDERS,
  EMBEDDING_CAPABLE_PROVIDERS,
};
