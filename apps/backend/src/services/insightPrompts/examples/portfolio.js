/**
 * L4 — PORTFOLIO few-shot examples, keyed by lens.
 *
 * Investment-analyst voice. Numbers reference fundamentals (P/E, yield,
 * weights, sector mix) rather than market direction. Never recommend trades.
 */

const examples = {
  PORTFOLIO_EXPOSURE: {
    lens: 'PORTFOLIO_EXPOSURE',
    title: 'Equity at 71%, Bonds Hold 18% of the Book',
    body: "Of the $412,300 portfolio, 71% is equity — 38% index ETFs, 29% individual stocks, 4% REITs — with government and corporate bonds at 18% and real estate at 11%. The bonds carry $74,000 of face value at a 4.6% weighted coupon and 3.8 years to maturity on average, 70% government. Top three positions: VTI (21%), the Lisbon apartment (11%) and AAPL (6%), none above the 25% single-holding flag.",
    severity: 'INFO',
    priority: 55,
    category: 'PORTFOLIO',
    metadata: {
      dataPoints: { current: 71, prior: 72, yoy: null, deltaPct: -1.4 },
      actionTypes: ['PORTFOLIO_REBALANCE'],
      relatedLenses: ['SECTOR_CONCENTRATION', 'PASSIVE_INCOME_OUTLOOK'],
      suggestedAction: 'No action signal — the mix is inside normal bounds.',
    },
  },

  SECTOR_CONCENTRATION: {
    lens: 'SECTOR_CONCENTRATION',
    title: 'Technology at 44% Once ETFs Are Looked Through',
    body: "Looking through ETFs, Technology is 44% of the $268,000 equity book, above the 40% single-sector flag. It comes from direct holdings NVDA and AAPL plus 59% of QQQ and 31% of VTI. Inside that, Semiconductors alone is 17% of equity (NVDA, AMD). Financials follow at 13% and Healthcare at 11%; bonds and property are outside this view by design.",
    severity: 'WARNING',
    priority: 75,
    category: 'PORTFOLIO',
    metadata: {
      dataPoints: { current: 44, prior: 43, yoy: null, deltaPct: 2.3 },
      actionTypes: ['PORTFOLIO_REBALANCE'],
      relatedLenses: ['PORTFOLIO_EXPOSURE', 'VALUATION_RISK'],
      suggestedAction: 'Directing new contributions to non-tech exposure would dilute the sector share without selling.',
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
    title: '$4,380 in Stock and ETF Dividends Ahead',
    body: "Stocks and ETFs are projected to pay $4,380 in dividends over the next 12 months, replaying the last year of payments on current share counts. The dividend-paying holdings total $185,000, a weighted yield of 2.4% on that allocation. JNJ, KO and VTI carry most of it; JNJ's 4% raise in February is already in the figure.",
    severity: 'INFO',
    priority: 45,
    category: 'PORTFOLIO',
    metadata: {
      dataPoints: { current: 2.4, prior: 2.3, yoy: null, deltaPct: 4.3 },
      actionTypes: ['PORTFOLIO_REBALANCE'],
      relatedLenses: ['PASSIVE_INCOME_OUTLOOK'],
      suggestedAction: 'Reinvesting dividends into the same holdings compounds the yield over time.',
    },
  },

  PASSIVE_INCOME_OUTLOOK: {
    lens: 'PASSIVE_INCOME_OUTLOOK',
    title: '31% of Passive Income Ends With a Bond in March',
    body: "Bliss projects $9,600 of passive income over the next 12 months (gross, before tax) — $8,400 from investments and $1,200 from a family allowance — against $8,900 actually received in the last 12 months. That covers 22% of essential spending. The Treasury 2027 bond matures on 2027-03-15 and takes $250 a month with it, 31% of the projection. Its floating coupon uses the rate you assumed.",
    severity: 'WARNING',
    priority: 70,
    category: 'INCOME',
    metadata: {
      dataPoints: { current: 22, prior: 21, yoy: null, deltaPct: 7.9 },
      actionTypes: ['INCOME_GROWTH'],
      relatedLenses: ['DIVIDEND_OPPORTUNITY', 'PORTFOLIO_EXPOSURE'],
      suggestedAction: 'Decide ahead of March where the maturing principal goes, so the income gap is planned rather than discovered.',
    },
  },
};

module.exports = { examples };
