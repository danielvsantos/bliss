module.exports = {
  name: 'SAVINGS_TREND',
  rubric: `SAVINGS_TREND
Focus: direction of the savings rate over the trailing 3-6 months.
Severity:
- WARNING:  declining 3+ consecutive months.
- INFO:     stable within a ±2pp band.
- POSITIVE: rising 3+ consecutive months.
Pair the trend with the most likely driver (income up vs spending down), citing both endpoints. When a single within-window data point sharpens the trend (e.g. the lowest month), name it.`,
};
