/**
 * Shared JSON schema for the Insight output contract.
 *
 * Imported by all three LLM adapters when they configure structured output:
 *   - Anthropic: passed to a forced-tool-use `submit_insights` tool
 *   - OpenAI:    response_format: { type: 'json_schema', json_schema, strict: true }
 *   - Gemini:    generationConfig.responseSchema
 *
 * Keep additionalProperties:false to make the providers strict-validate the
 * output. metadata.* fields are intentionally permissive — the LLM may emit
 * partial dataPoints and that's fine; the service-layer validation in
 * insightService.js does final cleanup before persisting.
 */

const VALID_LENSES = [
  'SPENDING_VELOCITY', 'CATEGORY_CONCENTRATION', 'UNUSUAL_SPENDING',
  'INCOME_STABILITY', 'INCOME_DIVERSIFICATION',
  'SAVINGS_RATE', 'SAVINGS_TREND',
  'PORTFOLIO_EXPOSURE', 'SECTOR_CONCENTRATION', 'VALUATION_RISK', 'DIVIDEND_OPPORTUNITY',
  'DEBT_HEALTH', 'DEBT_PAYOFF_TRAJECTORY',
  'NET_WORTH_TRAJECTORY', 'NET_WORTH_MILESTONES',
];

const VALID_CATEGORIES = ['SPENDING', 'INCOME', 'SAVINGS', 'PORTFOLIO', 'DEBT', 'NET_WORTH'];
const VALID_SEVERITIES = ['POSITIVE', 'INFO', 'WARNING', 'CRITICAL'];
const VALID_ACTION_TYPES = [
  'BUDGET_OPTIMIZATION', 'TAX_EFFICIENCY', 'PORTFOLIO_REBALANCE',
  'DEBT_REDUCTION', 'SAVINGS_GOAL', 'EMERGENCY_FUND', 'INCOME_GROWTH',
  'TRAVEL_PLANNING',
];

const insightItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'title', 'body', 'severity', 'priority', 'category', 'metadata'],
  properties: {
    lens:     { type: 'string', enum: VALID_LENSES },
    title:    { type: 'string', minLength: 1, maxLength: 80 },
    body:     { type: 'string', minLength: 1 },
    severity: { type: 'string', enum: VALID_SEVERITIES },
    priority: { type: 'integer', minimum: 1, maximum: 100 },
    category: { type: 'string', enum: VALID_CATEGORIES },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['dataPoints', 'actionTypes', 'relatedLenses', 'suggestedAction'],
      properties: {
        // Fixed-shape dataPoints — keeps the schema strict-mode compatible
        // across OpenAI's response_format json_schema (which forbids
        // additionalProperties: <type>) and Gemini's responseSchema (which
        // has limited dialect support). Other useful per-lens numbers can
        // live in the body text; this block is the canonical four-up
        // current / prior / yoy / deltaPct.
        dataPoints: {
          type: 'object',
          additionalProperties: false,
          required: ['current', 'prior', 'yoy', 'deltaPct'],
          properties: {
            current:  { type: ['number', 'null'] },
            prior:    { type: ['number', 'null'] },
            yoy:      { type: ['number', 'null'] },
            deltaPct: { type: ['number', 'null'] },
          },
        },
        actionTypes: {
          type: 'array',
          items: { type: 'string', enum: VALID_ACTION_TYPES },
          minItems: 0,
          maxItems: 3,
        },
        relatedLenses: {
          type: 'array',
          items: { type: 'string', enum: VALID_LENSES },
          minItems: 0,
          maxItems: 4,
        },
        suggestedAction: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
  },
};

/**
 * Top-level array schema. Some providers (OpenAI's strict json_schema) reject
 * bare arrays at the root, so we also export an "object-wrapped" form for
 * those cases. Adapters pick whichever they need.
 */
const insightArraySchema = {
  type: 'array',
  items: insightItemSchema,
};

const insightWrappedSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: insightArraySchema,
  },
};

module.exports = {
  insightItemSchema,
  insightArraySchema,
  insightWrappedSchema,
  VALID_LENSES,
  VALID_CATEGORIES,
  VALID_SEVERITIES,
  VALID_ACTION_TYPES,
};
