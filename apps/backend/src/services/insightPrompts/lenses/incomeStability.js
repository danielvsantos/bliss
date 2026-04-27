module.exports = {
  name: 'INCOME_STABILITY',
  rubric: `INCOME_STABILITY
Focus: variance of monthly income over the trailing 6 months and presence of the expected income event this period.
Severity:
- CRITICAL: an expected primary income did not arrive this period (gap inside an established pattern).
- WARNING:  income coefficient-of-variation >0.30 (high volatility).
- INFO:     income within ±10% of trailing average.
- POSITIVE: income up ≥5% sustained ≥3 months.
For users with intentionally variable income (freelance, commission), volatility is a feature not a bug — note the variability without scoring it as concerning unless it produced a coverage gap.`,
};
