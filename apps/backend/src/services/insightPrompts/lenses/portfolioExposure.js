module.exports = {
  name: 'PORTFOLIO_EXPOSURE',
  rubric: `PORTFOLIO_EXPOSURE
Focus: asset-class mix (equity / fixed income / cash / other) as % of total portfolio value, and the top 3 holdings by weight.
Severity:
- WARNING:  cash >25% of a non-trivial portfolio (drag), OR equity >95% (concentration), OR a single holding >25% of total.
- INFO:     mix shifted ≥5pp in any class vs prior week.
- POSITIVE: mix moved toward a stated target (only when one is provided).
Never recommend a target mix or rebalance — describe the current shape and let the user decide.`,
};
