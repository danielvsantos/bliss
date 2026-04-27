/**
 * L4 — QUARTERLY few-shot examples, keyed by lens.
 */

const examples = {
  SPENDING_VELOCITY: {
    lens: 'SPENDING_VELOCITY',
    title: 'Quarterly Spending Up 6% on Stable Mix',
    body: "Q1 spending totaled $14,820, up 6% from Q4's $13,980 and within 2% of last year's Q1. The increase was distributed across Dining, Transport, and Utilities — none of them dominant — rather than concentrated in one category. The shape of spending is essentially unchanged; the level is modestly higher.",
    severity: 'INFO',
    priority: 50,
    category: 'SPENDING',
    metadata: {
      dataPoints: { current: 14820, prior: 13980, yoy: 14510, deltaPct: 6 },
      actionTypes: ['BUDGET_OPTIMIZATION'],
      relatedLenses: ['CATEGORY_CONCENTRATION', 'SAVINGS_RATE'],
      suggestedAction: 'A 6% drift over a quarter is worth a brief mid-year review of the bigger discretionary categories.',
    },
  },

  CATEGORY_CONCENTRATION: {
    lens: 'CATEGORY_CONCENTRATION',
    title: 'Top Category Mix Stable Across the Quarter',
    body: "Housing was $5,040 of Q1's $27,600 income — 18% of income, in line with the 6-month baseline of 18%. The next two — Dining at 8% of income and Transport at 6% — were also within their normal bands. Concentration risk is unchanged; spend is shaped the way it usually is.",
    severity: 'INFO',
    priority: 40,
    category: 'SPENDING',
    metadata: {
      dataPoints: { current: 18, prior: 18, yoy: 19, deltaPct: 0 },
      actionTypes: ['BUDGET_OPTIMIZATION'],
      relatedLenses: ['SPENDING_VELOCITY'],
      suggestedAction: 'No action needed — the mix is stable.',
    },
  },

  INCOME_STABILITY: {
    lens: 'INCOME_STABILITY',
    title: 'Income Held Steady Across Q1',
    body: "Total Q1 income was $27,600, an average of $9,200 monthly with very low variance (CoV 0.03). The expected payroll cycle held all three months. Compared to Q1 last year ($26,400), income is up 4.5% — a real but modest raise effect.",
    severity: 'POSITIVE',
    priority: 50,
    category: 'INCOME',
    metadata: {
      dataPoints: { current: 27600, prior: 27450, yoy: 26400, deltaPct: 4.5 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['SAVINGS_RATE'],
      suggestedAction: 'Stable income makes this a natural time to revisit the savings target for the year.',
    },
  },

  INCOME_DIVERSIFICATION: {
    lens: 'INCOME_DIVERSIFICATION',
    title: 'Single Income Source Held the Quarter',
    body: "One employer accounted for $26,300 of Q1's $27,600 — 95% — with the remaining $1,300 from a one-off consulting payment in February. That share matches last quarter and is typical for a salaried profile. Concentration is not a concern in itself, but diversification, if it ever appears, is worth noting.",
    severity: 'INFO',
    priority: 35,
    category: 'INCOME',
    metadata: {
      dataPoints: { current: 95, prior: 95, yoy: 96, deltaPct: 0 },
      actionTypes: ['INCOME_GROWTH'],
      relatedLenses: ['INCOME_STABILITY'],
      suggestedAction: 'No action needed — single-source income is the standard pattern.',
    },
  },

  SAVINGS_RATE: {
    lens: 'SAVINGS_RATE',
    title: 'Q1 Savings Rate Held at 16%',
    body: "Q1 savings averaged 16% of income, essentially flat against Q4's 17% and within 1pp of the trailing-12-month figure. Total saved across the quarter was $4,420 against $27,600 of income. Healthy and unchanged is the right shorthand.",
    severity: 'INFO',
    priority: 50,
    category: 'SAVINGS',
    metadata: {
      dataPoints: { current: 16, prior: 17, yoy: 14, deltaPct: -6 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['SAVINGS_TREND'],
      suggestedAction: 'Holding 16% through the year would compound to roughly $17k saved.',
    },
  },

  SAVINGS_TREND: {
    lens: 'SAVINGS_TREND',
    title: 'Savings Rate Compressed Three Months Running',
    body: "The savings rate fell from 22.4% in Q4 to 14.1% in Q1, with March closing at just 9.7%. Income held steady around $18,400 monthly, so the slide is spending-driven — discretionary categories accounted for most of the increase. At this pace, savings dip below 10% by Q2.",
    severity: 'WARNING',
    priority: 78,
    category: 'SAVINGS',
    metadata: {
      dataPoints: { current: 14.1, prior: 22.4, yoy: 19.8, deltaPct: -37.1 },
      actionTypes: ['BUDGET_OPTIMIZATION', 'SAVINGS_GOAL'],
      relatedLenses: ['SPENDING_VELOCITY', 'CATEGORY_CONCENTRATION'],
      suggestedAction: 'One option would be capping discretionary spend at the Q4 monthly average through April.',
    },
  },

  DEBT_HEALTH: {
    lens: 'DEBT_HEALTH',
    title: 'Debt Servicing Inside Comfortable Range',
    body: "Total debt fell from $44,200 to $40,580 across Q1, with $3,180 going to principal. The weighted rate edged from 5.4% to 5.2%. Debt servicing is 12% of income — comfortably inside a sustainable range.",
    severity: 'POSITIVE',
    priority: 50,
    category: 'DEBT',
    metadata: {
      dataPoints: { current: 40580, prior: 44200, yoy: 48400, deltaPct: -8.2 },
      actionTypes: ['DEBT_REDUCTION'],
      relatedLenses: ['DEBT_PAYOFF_TRAJECTORY', 'NET_WORTH_TRAJECTORY'],
      suggestedAction: 'Continuing this pace would clear the credit-card balance within a year.',
    },
  },

  DEBT_PAYOFF_TRAJECTORY: {
    lens: 'DEBT_PAYOFF_TRAJECTORY',
    title: 'Credit-Card Payoff Pulled Forward Three Months',
    body: "At the Q1 payment pace ($810 monthly average vs the $290 minimum), the credit-card balance ($4,820 at quarter close) projects to clear in 14 months — three months earlier than the Q4 projection. The mortgage trajectory is unchanged, on its standard amortization. The acceleration is concentrated on the card, not spread across all instruments.",
    severity: 'POSITIVE',
    priority: 65,
    category: 'DEBT',
    metadata: {
      dataPoints: { current: 14, prior: 17, yoy: null, deltaPct: -18 },
      actionTypes: ['DEBT_REDUCTION'],
      relatedLenses: ['DEBT_HEALTH'],
      suggestedAction: 'Holding the $810 monthly payment is what makes the projection real.',
    },
  },

  NET_WORTH_TRAJECTORY: {
    lens: 'NET_WORTH_TRAJECTORY',
    title: 'Net Worth Up $13,200 in Q1',
    body: "Net worth rose from $234,500 at Q4 close to $247,700 at Q1 close — a 5.6% gain. Stocks led the move at +$5,800, ETFs added $3,600, and Real Estate appreciated $3,000. Mortgage principal fell by $2,100 of paydown, and Crypto moved $900. The growth was diversified across the portfolio, not driven by any single holding.",
    severity: 'POSITIVE',
    priority: 70,
    category: 'NET_WORTH',
    metadata: {
      dataPoints: { current: 247700, prior: 234500, yoy: 215000, deltaPct: 5.6 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['SAVINGS_RATE', 'DEBT_HEALTH'],
      suggestedAction: 'Locking in another quarter at this pace would put net worth past $260k by mid-year.',
    },
  },

  NET_WORTH_MILESTONES: {
    lens: 'NET_WORTH_MILESTONES',
    title: 'Approaching the $250k Mark',
    body: "Net worth ended Q1 at $247,700 — within 1% of the $250,000 milestone. At the Q1 saving pace, the milestone is roughly two months out. The previous milestone ($100k) was reached 41 months ago, so the second 100k is taking about a third of the time of the first.",
    severity: 'INFO',
    priority: 60,
    category: 'NET_WORTH',
    metadata: {
      dataPoints: { current: 247700, prior: 234500, yoy: 215000, deltaPct: 5.6 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['NET_WORTH_TRAJECTORY'],
      suggestedAction: 'Consider what crossing $250k should mean — naming the milestone makes it count.',
    },
  },
};

module.exports = { examples };
