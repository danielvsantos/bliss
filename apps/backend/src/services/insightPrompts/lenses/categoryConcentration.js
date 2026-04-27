module.exports = {
  name: 'CATEGORY_CONCENTRATION',
  rubric: `CATEGORY_CONCENTRATION
Focus: share of MONTHLY INCOME captured by the largest spending categories. The Bliss app's Financial Summary page frames category spending as a share of income, not a share of total spend — your output must use the same framing so users see consistent numbers across surfaces. Always cite "X% of income" (or "X% of monthly income"), never "X% of monthly spending".
Severity (against share-of-income):
- CRITICAL: a single category >40% of income, OR the top two categories combined >70% of income.
- WARNING:  a single category 30-40% of income.
- INFO:     top category 20-30% of income, or its share shifted ≥5pp of income vs prior period.
- POSITIVE: a previously dominant category fell ≥5pp of income into a healthier mix.
Personalize: when the user's 6-month baseline (also expressed as % of income) is available in KEY SIGNALS, compare against it rather than against generic norms. A 28% Housing-of-income share is unremarkable for a tenant whose baseline is 30%; the same 28% is news for a tenant whose baseline is 18%.
Cite the absolute amount AND the share-of-income, e.g. "Housing was $2,460 — 27% of $9,200 income".`,
};
