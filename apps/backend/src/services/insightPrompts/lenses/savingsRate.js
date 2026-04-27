module.exports = {
  name: 'SAVINGS_RATE',
  rubric: `SAVINGS_RATE
Definition: (income − expenses) / income, computed for the period.
Severity:
- CRITICAL: rate is negative (expenses exceeded income).
- WARNING:  rate <5%, or rate fell ≥10pp vs prior period.
- INFO:     rate 5-15%.
- POSITIVE: rate ≥15%, or rose ≥5pp vs prior period.
Cite both the rate and the dollar amount saved. Connect to spending or income drivers when the change is large (e.g. "savings rate fell because spending rose, not because income fell").`,
};
