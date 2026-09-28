module.exports = {
  name: 'PASSIVE_INCOME_OUTLOOK',
  rubric: `PASSIVE_INCOME_OUTLOOK
Focus: the next 12 months of passive income, as projected by Bliss's deterministic engine from the user's holdings, income terms and income streams. Every number is in KEY SIGNALS → \`passiveIncome\`; never estimate or re-derive a projection yourself.
Anchor on \`next12m.total\` and its split: \`next12m.investment\` (dividends, coupons, rent, interest) vs \`next12m.other\` (allowance, welfare and similar streams). Compare with \`trailing12mActual\` (what actually arrived over the last 12 months). Always state \`essentialsCoveragePct\` — the share of the last 12 months of essential spending that the projected income covers. Name the largest contributor from \`topContributors\` with its share.
Severity (use \`passiveIncome.triggers\`, already computed):
- WARNING: \`triggers.endingIncomeWarning\` (≥20% of projected income stops within 12 months — name the items in \`endingWithin12m.items\` and their end dates) OR \`triggers.singleSourceWarning\` (one holding or stream is >50% of projected income).
- POSITIVE: \`triggers.coverageMilestoneCrossed\` is set — essential-spending coverage just passed that milestone (25/50/75/100%) since the previous insight.
- INFO: otherwise.
Honesty rules — always follow:
- Projections are GROSS (before tax). Say so once.
- When \`triggers.usesAssumedRates\` is true, say that floating-rate and inflation-linked figures use the rates the user assumed (name 1-2 of \`assumedRates.labels\`).
- When \`triggers.incompleteData\` is true (\`coverage.pct\` below 80), say the projection is incomplete and name up to 3 of \`coverage.missingLabels\`.
- Allowance, pension, welfare and other streams are NON-investment income. Never describe them as investment returns or yield.
- Never recommend a specific security, and never predict dividend changes.
metadata: \`dataPoints.current\` = \`essentialsCoveragePct\` (null when unknown), \`dataPoints.prior\` = \`priorEssentialsCoveragePct\`, \`dataPoints.yoy\` = null, \`dataPoints.deltaPct\` = change of \`next12m.total\` vs \`trailing12mActual\` in % (null when the trailing figure is 0). actionTypes: include \`PASSIVE_INCOME_SETUP\` when \`triggers.incompleteData\`; include \`INCOME_GROWTH\` on an ending-income WARNING.`,
};
