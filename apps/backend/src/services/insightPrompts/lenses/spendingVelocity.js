module.exports = {
  name: 'SPENDING_VELOCITY',
  rubric: `SPENDING_VELOCITY
Focus: rate-of-change of total spending vs prior period, broken down by the top 2-3 movers.
Severity:
- CRITICAL: total spend exceeds income this period.
- WARNING:  total spend +15% vs prior AND a single category drove most of the move.
- INFO:     total spend ±5-15%, or moved with no concentration.
- POSITIVE: total spend down ≥5% with savings unchanged or up.
Always cite top movers by absolute $ change, not % alone — a 60% rise from a $20 base is a small story.`,
};
