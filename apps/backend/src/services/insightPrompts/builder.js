/**
 * Insight prompt builder — assembles the layered system + user messages
 * from the four content layers (L1 identity, L2 tier addendum, L3 lens
 * rubrics, L4 few-shot examples) and returns blocks the LLM adapters
 * can pass to their respective APIs.
 *
 * The system blocks are returned in an array shape so adapters that
 * support per-block prompt caching (Anthropic) can attach `cache_control`
 * to each block independently. Adapters that prefer a single string
 * (Gemini's `systemInstruction`, OpenAI's first system message) can
 * concatenate them.
 *
 *   buildSystemBlocks(tier, activeLenses) →
 *     [
 *       { kind: 'identity',  text: <L1> },     // cache: global
 *       { kind: 'tier',      text: <L2> },     // cache: per tier
 *       { kind: 'lenses',    text: <L3> },     // cache: per lens-set
 *       { kind: 'examples',  text: <L4> },     // cache: per lens-set
 *     ]
 *
 *   buildUserMessage(tier, tenantData, activeLenses) →
 *     plain string
 */

const { buildSystemBase } = require('./identity');
const { computeKeySignals } = require('./keySignals');

// Lens-rubric registry (one require per lens — single source of truth)
const lensRubrics = {
  SPENDING_VELOCITY:       require('./lenses/spendingVelocity'),
  CATEGORY_CONCENTRATION:  require('./lenses/categoryConcentration'),
  UNUSUAL_SPENDING:        require('./lenses/unusualSpending'),
  INCOME_STABILITY:        require('./lenses/incomeStability'),
  INCOME_DIVERSIFICATION:  require('./lenses/incomeDiversification'),
  SAVINGS_RATE:            require('./lenses/savingsRate'),
  SAVINGS_TREND:           require('./lenses/savingsTrend'),
  PORTFOLIO_EXPOSURE:      require('./lenses/portfolioExposure'),
  SECTOR_CONCENTRATION:    require('./lenses/sectorConcentration'),
  VALUATION_RISK:          require('./lenses/valuationRisk'),
  DIVIDEND_OPPORTUNITY:    require('./lenses/dividendOpportunity'),
  DEBT_HEALTH:             require('./lenses/debtHealth'),
  DEBT_PAYOFF_TRAJECTORY:  require('./lenses/debtPayoffTrajectory'),
  NET_WORTH_TRAJECTORY:    require('./lenses/netWorthTrajectory'),
  NET_WORTH_MILESTONES:    require('./lenses/netWorthMilestones'),
};

const tierAddendums = {
  MONTHLY:   require('./tiers/monthly'),
  QUARTERLY: require('./tiers/quarterly'),
  ANNUAL:    require('./tiers/annual'),
  PORTFOLIO: require('./tiers/portfolio'),
};

const tierExamples = {
  MONTHLY:   require('./examples/monthly').examples,
  QUARTERLY: require('./examples/quarterly').examples,
  ANNUAL:    require('./examples/annual').examples,
  PORTFOLIO: require('./examples/portfolio').examples,
};

/** Build the L3 block: concatenated rubrics for the active lenses. */
function buildLensesBlock(activeLenses) {
  const blocks = activeLenses
    .map((lens) => lensRubrics[lens]?.rubric)
    .filter(Boolean);
  if (!blocks.length) return null;
  return `LENS RUBRICS (active for this run):\n\n${blocks.join('\n\n')}`;
}

/** Build the L4 block: filtered few-shot examples for the active lenses. */
function buildExamplesBlock(tier, activeLenses) {
  const all = tierExamples[tier] || {};
  const picked = activeLenses
    .map((lens) => all[lens])
    .filter(Boolean);
  if (!picked.length) return null;
  // Header + JSON-stringified per-example block. Numbered so the model can
  // refer back to them mentally if it needs.
  const blocks = picked.map((ex, i) =>
    `Example ${i + 1} — ${ex.lens} (${ex.severity}):\n${JSON.stringify(ex, null, 2)}`,
  );
  return `FEW-SHOT EXAMPLES (calibration reference for voice, structure, severity, and metadata. Do not copy values; use the shape.):\n\n${blocks.join('\n\n')}`;
}

/** Build the four system message blocks for a given tier + lens set. */
function buildSystemBlocks(tier, activeLenses) {
  const blocks = [];
  blocks.push({ kind: 'identity', text: buildSystemBase() });

  const tierMod = tierAddendums[tier];
  if (tierMod) {
    blocks.push({ kind: 'tier', text: tierMod.buildTierAddendum() });
  }

  const lensesText = buildLensesBlock(activeLenses);
  if (lensesText) blocks.push({ kind: 'lenses', text: lensesText });

  const examplesText = buildExamplesBlock(tier, activeLenses);
  if (examplesText) blocks.push({ kind: 'examples', text: examplesText });

  return blocks;
}

/** Concatenated form for adapters that accept a single system string. */
function buildSystemString(tier, activeLenses) {
  return buildSystemBlocks(tier, activeLenses).map((b) => b.text).join('\n\n');
}

/** Strip internal/derived flags before serializing the financial-data section. */
function stripInternalFlags(tenantData) {
  // eslint-disable-next-line no-unused-vars
  const { tier, hasTransactions, hasPortfolio, hasDebt, comparisonAvailable, ...rest } = tenantData;
  return rest;
}

/**
 * Build the user message: period context, comparison availability,
 * KEY SIGNALS (pre-computed), FINANCIAL DATA (raw), and the lens list
 * the model should produce.
 */
function buildUserMessage(tier, tenantData, activeLenses) {
  const keySignals = computeKeySignals(tenantData, tier);
  const financialData = stripInternalFlags(tenantData);
  const comparison = tenantData.comparisonAvailable || {};

  return `PERIOD: ${tenantData.targetPeriod || tier}
PORTFOLIO CURRENCY: ${tenantData.portfolioCurrency || 'USD'}

COMPARISON DATA AVAILABILITY:
${JSON.stringify(comparison, null, 2)}

KEY SIGNALS (pre-computed deltas, baselines, and anomalies — start here):
${JSON.stringify(keySignals, null, 2)}

FINANCIAL DATA (raw context — fall back here for any number not in KEY SIGNALS):
${JSON.stringify(financialData, null, 2)}

ACTIVE LENSES (produce exactly one insight per lens, in this order):
${activeLenses.join(', ')}`;
}

module.exports = {
  buildSystemBlocks,
  buildSystemString,
  buildUserMessage,
  // Exposed for tests + introspection
  lensRubrics,
  tierAddendums,
  tierExamples,
};
