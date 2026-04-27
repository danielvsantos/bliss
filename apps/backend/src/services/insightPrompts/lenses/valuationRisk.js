module.exports = {
  name: 'VALUATION_RISK',
  rubric: `VALUATION_RISK
Focus: weighted-average P/E of equity holdings vs broad-market P/E (provided in KEY SIGNALS when available). Treat this lens as CONTEXT, not a flag — P/E from third-party data sources is approximate, can be stale, and varies by methodology. The reader is well-served by the figure but should not be alarmed by it.
Severity:
- INFO (default): describe the weighted P/E and how it compares to the market — both directions.
- POSITIVE: rare — only when the prior period's elevated P/E has compressed materially.
- WARNING: rare — only when weighted P/E is extreme (>40) AND concentrated in 1-2 holdings.
Priority: cap at 50 (this lens is informational, not a top-of-page concern).
Name the 1-2 holdings driving the weighted figure. Phrase comparisons descriptively: "trades at 28× earnings vs market 21×," never "is overvalued." Add "(approximate)" or note that P/E varies by source if you cite a specific number you want to qualify. Skip this lens entirely if no holding has trusted P/E data — the active-lens filter handles that automatically.`,
};
