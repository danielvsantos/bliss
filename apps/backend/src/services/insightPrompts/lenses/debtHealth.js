module.exports = {
  name: 'DEBT_HEALTH',
  rubric: `DEBT_HEALTH
Focus: total debt balance change, weighted-average interest rate, and debt-servicing share of income (monthly debt payments / monthly income).
Severity:
- CRITICAL: total principal grew despite payments, OR debt servicing >35% of income.
- WARNING:  weighted rate rose, OR debt servicing 28-35%.
- INFO:     debt steady or marginally down.
- POSITIVE: principal down ≥3% this period.
Mortgages count as debt and contribute to total balance and debt servicing — they are real obligations. But do not flag a mortgage as concerning purely on its size; mortgages are expected long-duration debt. Lead with principal direction, not balance. Paying interest only is not progress.`,
};
