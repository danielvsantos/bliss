/**
 * L4 — PORTFOLIO few-shot examples, keyed by lens.
 *
 * Investment-analyst voice. Numbers reference fundamentals (P/E, yield,
 * weights, sector mix) rather than market direction. Never recommend trades.
 */

const examples = {
  PORTFOLIO_EXPOSURE: {
    lens: 'PORTFOLIO_EXPOSURE',
    title: 'Equity Heavy at 84% — Top Three at 27%',
    body: "Equity carried 84% of the portfolio's $312,400 at week close. Top three positions: VTI (12%), AAPL (8%), BRK.B (7%) — none crossing the 25% concentration threshold. Mix shifted modestly from the prior week, not directionally.",
    severity: 'INFO',
    priority: 55,
    category: 'PORTFOLIO',
    metadata: {
      dataPoints: { current: 84, prior: 82, yoy: 81, deltaPct: 2.4 },
      actionTypes: ['PORTFOLIO_REBALANCE'],
      relatedLenses: ['SECTOR_CONCENTRATION'],
      suggestedAction: 'No action signal — the mix is inside normal bounds.',
    },
  },

  SECTOR_CONCENTRATION: {
    lens: 'SECTOR_CONCENTRATION',
    title: 'Technology at 47% — Semiconductors Alone Carry 28%',
    body: "Technology accounts for 47% of the equity portfolio, well above the 25% single-sector flag. Inside that, Semiconductors alone is 28% of the equity book — driven by NVDA and AMD — with Software a further 12% (MSFT, ADBE) and Consumer Electronics 7% (AAPL). Financials sit at 18% and healthcare at 12%. The story isn't broad tech exposure so much as a concentrated chip bet.",
    severity: 'WARNING',
    priority: 75,
    category: 'PORTFOLIO',
    metadata: {
      dataPoints: { current: 47, prior: 45, yoy: 41, deltaPct: 4.4 },
      actionTypes: ['PORTFOLIO_REBALANCE'],
      relatedLenses: ['PORTFOLIO_EXPOSURE', 'VALUATION_RISK'],
      suggestedAction: 'A diversified ETF added against new contributions would gradually dilute sector share without selling.',
    },
  },

  VALUATION_RISK: {
    lens: 'VALUATION_RISK',
    title: 'Weighted P/E Around 28× (Approximate)',
    body: "The equity portfolio trades at a weighted P/E around 28×, against a broad-market figure near 21×. The two largest contributors are AAPL (~32×) and NVDA (~51×), together about 22% of equity weight. P/E figures from third-party data are approximate and can shift with new earnings releases — treat the number as context, not a verdict.",
    severity: 'INFO',
    priority: 35,
    category: 'PORTFOLIO',
    metadata: {
      dataPoints: { current: 28, prior: 27, yoy: 23, deltaPct: 21.7 },
      actionTypes: ['PORTFOLIO_REBALANCE'],
      relatedLenses: ['SECTOR_CONCENTRATION'],
      suggestedAction: 'No action signal — multiples are context, not a trigger.',
    },
  },

  DIVIDEND_OPPORTUNITY: {
    lens: 'DIVIDEND_OPPORTUNITY',
    title: '$1,050 in Passive Income Over the Last 90 Days',
    body: "Passive Income posted $1,050 over the last 90 days, mostly from JNJ, KO, and PG dividends. The portfolio's dividend-paying stocks total $185,000 and yield about 2.3% on those holdings. Total stock allocation is $238,000, so dividends contribute roughly 1.8% on the broader stock book. Yield has been stable; the most recent change was JNJ's 4% dividend raise in February.",
    severity: 'INFO',
    priority: 45,
    category: 'PORTFOLIO',
    metadata: {
      dataPoints: { current: 2.3, prior: 2.3, yoy: 2.2, deltaPct: 0 },
      actionTypes: ['PORTFOLIO_REBALANCE'],
      relatedLenses: ['PORTFOLIO_EXPOSURE'],
      suggestedAction: 'Reinvesting dividends into the same holdings compounds the yield over time.',
    },
  },
};

module.exports = { examples };
