/**
 * L4 — ANNUAL few-shot examples, keyed by lens.
 *
 * Year-in-review voice — slightly longer bodies, defining-fact-first
 * opening, decomposition into drivers when data permits.
 */

const examples = {
  SPENDING_VELOCITY: {
    lens: 'SPENDING_VELOCITY',
    title: 'Annual Spending Up 8% — Modest Lifestyle Drift',
    body: "Total 2026 spending was $59,400, up 8% from 2025's $55,000. Growth was distributed across three categories — Dining, Transport, Utilities — rather than concentrated, with Dining adding the most at $1,580. Income grew 6% over the same period, so spending modestly outpaced earning. The pattern reads as gradual lifestyle drift rather than a single event.",
    severity: 'INFO',
    priority: 55,
    category: 'SPENDING',
    metadata: {
      dataPoints: { current: 59400, prior: 55000, yoy: 55000, deltaPct: 8 },
      actionTypes: ['BUDGET_OPTIMIZATION'],
      relatedLenses: ['CATEGORY_CONCENTRATION', 'SAVINGS_RATE'],
      suggestedAction: 'A January reset on the three drift categories could keep 2027 closer to flat.',
    },
  },

  CATEGORY_CONCENTRATION: {
    lens: 'CATEGORY_CONCENTRATION',
    title: 'Housing Held 18% of Income All Year',
    body: "Housing was $20,200 of 2026's $112,000 income — 18%, in line with its 19% share of 2025 income. The next two — Dining at 7% of income and Groceries at 6% — also held their previous-year shape. Concentration was steady; the dominant categories are the dominant categories. None of the lower-share categories crossed into the top three this year.",
    severity: 'INFO',
    priority: 40,
    category: 'SPENDING',
    metadata: {
      dataPoints: { current: 18, prior: 19, yoy: 19, deltaPct: -5 },
      actionTypes: ['BUDGET_OPTIMIZATION'],
      relatedLenses: ['SPENDING_VELOCITY'],
      suggestedAction: 'No action needed — the mix held steady all year.',
    },
  },

  INCOME_STABILITY: {
    lens: 'INCOME_STABILITY',
    title: 'Income Up 6% on a Mid-Year Raise',
    body: "Total 2026 income was $112,000, a 6% lift over 2025's $105,800. The shape was steady — twelve consecutive monthly deposits, no missing cycles — with the step-up landing in July ($9,500/month before, $9,900/month after). That mid-year raise accounts for most of the YoY change. Coefficient of variation across the year was 0.05 — exceptionally stable.",
    severity: 'POSITIVE',
    priority: 60,
    category: 'INCOME',
    metadata: {
      dataPoints: { current: 112000, prior: 105800, yoy: 105800, deltaPct: 5.9 },
      actionTypes: ['SAVINGS_GOAL', 'INCOME_GROWTH'],
      relatedLenses: ['SAVINGS_RATE', 'SAVINGS_TREND'],
      suggestedAction: 'A mid-year raise that sticks is a natural moment to push the savings rate up another notch.',
    },
  },

  INCOME_DIVERSIFICATION: {
    lens: 'INCOME_DIVERSIFICATION',
    title: 'Single Source Held 96% of 2026 Income',
    body: "One employer accounted for $107,800 of $112,000 in 2026 — 96%. The remaining $4,200 came from sporadic consulting and one tax refund. That concentration matches 2025 (95%) and is typical of a salaried profile; the platform does not score it as a risk in itself. A diversified second source, if it ever materializes, would be worth flagging.",
    severity: 'INFO',
    priority: 35,
    category: 'INCOME',
    metadata: {
      dataPoints: { current: 96, prior: 95, yoy: 95, deltaPct: 1 },
      actionTypes: ['INCOME_GROWTH'],
      relatedLenses: ['INCOME_STABILITY'],
      suggestedAction: 'No action needed — concentration is normal for salaried profiles.',
    },
  },

  SAVINGS_RATE: {
    lens: 'SAVINGS_RATE',
    title: 'Savings Rate Climbed to 18% — Best Year on Record',
    body: "2026 closed with an 18% savings rate, the highest of any tracked year ($20,160 saved against $112,000 of income). 2025 was 14%, 2024 was 11%. The mid-year raise contributed roughly half the lift; tighter discretionary spending in Q3-Q4 contributed the rest. Holding 18% through 2027 would put the user past $40k saved across two years.",
    severity: 'POSITIVE',
    priority: 75,
    category: 'SAVINGS',
    metadata: {
      dataPoints: { current: 18, prior: 14, yoy: 14, deltaPct: 29 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['SAVINGS_TREND', 'NET_WORTH_TRAJECTORY'],
      suggestedAction: 'Setting an explicit 2027 target — even just "match this year" — turns the run into a goal.',
    },
  },

  SAVINGS_TREND: {
    lens: 'SAVINGS_TREND',
    title: 'Savings Trended Up Across the Year',
    body: "The savings rate climbed steadily through 2026: 13% in Q1, 16% in Q2, 19% in Q3, 24% in Q4 — each quarter a new high. Income explained the first half of the lift (the July raise); spending discipline explained the second (Q4 discretionary spend fell $1,800 below Q1). Both drivers held into the new year.",
    severity: 'POSITIVE',
    priority: 70,
    category: 'SAVINGS',
    metadata: {
      dataPoints: { current: 24, prior: 13, yoy: 14, deltaPct: 85 },
      actionTypes: ['SAVINGS_GOAL', 'BUDGET_OPTIMIZATION'],
      relatedLenses: ['SAVINGS_RATE', 'NET_WORTH_TRAJECTORY'],
      suggestedAction: 'The Q4 spending pattern is the one to keep — locking it in protects the gains.',
    },
  },

  DEBT_HEALTH: {
    lens: 'DEBT_HEALTH',
    title: 'Total Debt Down 12% Across 2026',
    body: "Total debt fell from $48,200 at end of 2025 to $42,400 at end of 2026 — a $5,800 reduction, with $4,900 going to principal. The weighted interest rate held at 5.3% all year. Debt servicing was 11% of income on average, comfortably inside a sustainable range. The credit card balance did most of the work; the mortgage moved on its standard amortization.",
    severity: 'POSITIVE',
    priority: 65,
    category: 'DEBT',
    metadata: {
      dataPoints: { current: 42400, prior: 48200, yoy: 48200, deltaPct: -12 },
      actionTypes: ['DEBT_REDUCTION'],
      relatedLenses: ['DEBT_PAYOFF_TRAJECTORY', 'NET_WORTH_TRAJECTORY'],
      suggestedAction: 'A repeat of this year would clear the highest-rate balance entirely.',
    },
  },

  DEBT_PAYOFF_TRAJECTORY: {
    lens: 'DEBT_PAYOFF_TRAJECTORY',
    title: 'Credit Card Cleared 18 Months Ahead of Schedule',
    body: "The credit card balance reached zero in October 2026 — 18 months earlier than the start-of-year projection. The user paid an average of $720/month against the $290 minimum, retiring $8,400 of principal over the year. With the card cleared, the household's only remaining debt is the mortgage at $34,000, on its standard amortization.",
    severity: 'POSITIVE',
    priority: 80,
    category: 'DEBT',
    metadata: {
      dataPoints: { current: 0, prior: 8400, yoy: 8400, deltaPct: -100 },
      actionTypes: ['DEBT_REDUCTION', 'SAVINGS_GOAL'],
      relatedLenses: ['DEBT_HEALTH', 'NET_WORTH_TRAJECTORY'],
      suggestedAction: 'The freed-up $720/month is the obvious savings or investment lever for 2027.',
    },
  },

  NET_WORTH_TRAJECTORY: {
    lens: 'NET_WORTH_TRAJECTORY',
    title: 'Net Worth Up $52,400 — A Defining Year',
    body: "Net worth grew from $214,200 at end of 2025 to $266,600 at end of 2026 — a $52,400 increase, or 24%. Stocks led at +$18,200, ETFs added $13,600, Real Estate appreciated $14,000, and Crypto returned $5,400 across the year. Mortgage principal fell by $5,800. This is the largest single-year gain on record, and the spread across equities, real estate, and crypto is what made the result durable rather than concentrated.",
    severity: 'POSITIVE',
    priority: 85,
    category: 'NET_WORTH',
    metadata: {
      dataPoints: { current: 266600, prior: 214200, yoy: 214200, deltaPct: 24 },
      actionTypes: ['SAVINGS_GOAL', 'PORTFOLIO_REBALANCE'],
      relatedLenses: ['SAVINGS_RATE', 'DEBT_HEALTH', 'NET_WORTH_MILESTONES'],
      suggestedAction: 'Investments and real estate both contributed materially this year — a rebalance check would be timely.',
    },
  },

  NET_WORTH_MILESTONES: {
    lens: 'NET_WORTH_MILESTONES',
    title: 'Crossed Both $250k and $260k This Year',
    body: "Net worth crossed both the $250k mark in March and $260k in November, finishing 2026 at $266,600. Three years ago the user crossed $100k; the second hundred thousand took 38 months and the third is on pace for roughly 28. The next round number ($500k) is about 5-6 years out at the trailing savings rate.",
    severity: 'POSITIVE',
    priority: 75,
    category: 'NET_WORTH',
    metadata: {
      dataPoints: { current: 266600, prior: 214200, yoy: 214200, deltaPct: 24 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['NET_WORTH_TRAJECTORY'],
      suggestedAction: 'Naming what $500k should mean turns the next milestone into something concrete.',
    },
  },
};

module.exports = { examples };
