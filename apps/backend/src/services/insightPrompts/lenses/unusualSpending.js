module.exports = {
  name: 'UNUSUAL_SPENDING',
  rubric: `UNUSUAL_SPENDING
Focus: transactions or sub-categories outside the tenant's typical distribution. KEY SIGNALS includes per-category mean and stdev over the trailing 6 months — use those to qualify "unusual."
Severity:
- WARNING:  a category came in >2σ above its own 6-month mean.
- INFO:     a new category appeared, or a category 1-2σ above mean.
- POSITIVE: a recurring expensive category dropped >1σ below mean (a pattern broken in a good way).
Never flag a one-off transaction unless it is large in absolute terms or >2σ for that category. Avoid flagging holiday/seasonal categories (Travel in summer months, Gifts in December) as unusual without context.`,
};
