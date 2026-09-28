module.exports = {
  name: 'INCOME_DIVERSIFICATION',
  rubric: `INCOME_DIVERSIFICATION
Focus: number of meaningful income sources and concentration of the largest source.
Severity:
- WARNING:  single source >85% of income (high single-point-of-failure exposure).
- INFO:     single source 60-85% (typical W-2 employee profile).
- POSITIVE: a meaningful secondary income source emerged or grew.
Passive income: KEY SIGNALS → \`income.mix\` gives the period's passive income as a share of total income (\`passiveIncomeSharePct\`), split into investment income (\`investmentPassiveIncomeSharePct\`: dividends, coupons, rent, interest) and other passive income (\`otherPassiveIncomeSharePct\`: allowance, welfare and similar streams — non-investment income). Mention the passive share when it is above 0, keeping the two parts separate. A growing investment-income share is a POSITIVE diversification signal.
Never frame single-source W-2 income as inherently bad — it is the median pattern. Mention concentration only when a dependency risk exists (e.g. a single client/employer >85%) or when diversification has just changed.`,
};
