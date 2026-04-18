/**
 * OpenAI LLM adapter — stub placeholder.
 *
 * Will be implemented in Step 3 of the multi-LLM rollout.
 * See docs/specs/backend/20-llm-provider-abstraction.md.
 */

function notImplemented() {
  throw new Error(
    'OpenAI adapter is not yet implemented. Use LLM_PROVIDER=gemini for now.'
  );
}

module.exports = {
  generateEmbedding: notImplemented,
  classifyTransaction: notImplemented,
  generateInsightContent: notImplemented,
  isRateLimitError: () => false,
  getDefaultModels: () => ({
    embedding: 'text-embedding-3-small',
    classification: 'gpt-4.1-mini',
    insight: 'gpt-4.1',
  }),
  getEmbeddingDimensions: () => 768,
};
