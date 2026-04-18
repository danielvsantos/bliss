/**
 * Anthropic LLM adapter — stub placeholder.
 *
 * Will be implemented in Step 4 of the multi-LLM rollout.
 * See docs/specs/backend/20-llm-provider-abstraction.md.
 *
 * Note: Anthropic does not provide an embedding API. The factory requires
 * EMBEDDING_PROVIDER=gemini or openai when LLM_PROVIDER=anthropic.
 */

function notImplemented() {
  throw new Error(
    'Anthropic adapter is not yet implemented. Use LLM_PROVIDER=gemini for now.'
  );
}

function embeddingsNotSupported() {
  throw new Error(
    'Anthropic does not support embeddings. Set EMBEDDING_PROVIDER=gemini or openai.'
  );
}

module.exports = {
  generateEmbedding: embeddingsNotSupported,
  classifyTransaction: notImplemented,
  generateInsightContent: notImplemented,
  isRateLimitError: () => false,
  getDefaultModels: () => ({
    embedding: null,
    classification: 'claude-sonnet-4-6',
    insight: 'claude-sonnet-4-6',
  }),
  getEmbeddingDimensions: () => 768,
};
