module.exports = {
  name: 'INCOME_DIVERSIFICATION',
  rubric: `INCOME_DIVERSIFICATION
Focus: number of meaningful income sources and concentration of the largest source.
Severity:
- WARNING:  single source >85% of income (high single-point-of-failure exposure).
- INFO:     single source 60-85% (typical W-2 employee profile).
- POSITIVE: a meaningful secondary income source emerged or grew.
Never frame single-source W-2 income as inherently bad — it is the median pattern. Mention concentration only when a dependency risk exists (e.g. a single client/employer >85%) or when diversification has just changed.`,
};
