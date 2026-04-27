/**
 * L4 — MONTHLY few-shot examples, keyed by lens.
 *
 * Eight examples covering every active monthly lens. Each one teaches the
 * model voice, structure, severity calibration, and metadata shape. The
 * builder filters at injection time so a tenant whose data only fires 3 of
 * these 8 lenses sees only 3 examples — keeping per-call payload bounded.
 *
 * Voice calibration: 4-6 numbers per body, approachable connectors,
 * observation-first, fiduciary tone.
 */

const examples = {
  SPENDING_VELOCITY: {
    lens: 'SPENDING_VELOCITY',
    title: 'Spending Held Flat Despite Dining Surge',
    body: "Total spending was $4,210 last month, just 1.2% below February's $4,260. One category did move: dining rose from $380 to $612, offset by a one-time February furniture purchase that did not repeat. Setting both aside, the run-rate is essentially unchanged.",
    severity: 'INFO',
    priority: 55,
    category: 'SPENDING',
    metadata: {
      dataPoints: { current: 4210, prior: 4260, yoy: 3980, deltaPct: -1.2 },
      actionTypes: ['BUDGET_OPTIMIZATION'],
      relatedLenses: ['CATEGORY_CONCENTRATION', 'UNUSUAL_SPENDING'],
      suggestedAction: 'Consider reviewing dining against the 3-month average before April closes.',
    },
  },

  CATEGORY_CONCENTRATION: {
    lens: 'CATEGORY_CONCENTRATION',
    title: 'Housing Crossed 27% of Income This Month',
    body: "Housing was $2,460 in March — 27% of $9,200 income, up from a 6-month baseline of 22%. Rent stayed at $1,800, but property insurance and a maintenance bill landed in the same month. The concentration reads as a one-month event rather than a structural shift.",
    severity: 'WARNING',
    priority: 70,
    category: 'SPENDING',
    metadata: {
      dataPoints: { current: 27, prior: 22, yoy: 21, deltaPct: 23 },
      actionTypes: ['BUDGET_OPTIMIZATION'],
      relatedLenses: ['SPENDING_VELOCITY'],
      suggestedAction: 'Watch April for whether the housing share-of-income returns to the 22% baseline.',
    },
  },

  UNUSUAL_SPENDING: {
    lens: 'UNUSUAL_SPENDING',
    title: 'New Travel Category Appeared in March',
    body: "Travel showed up at $1,180 this month after six months of zero activity. It traces to a single $720 airfare and a $460 hotel — typical of a planned trip rather than an emerging pattern. Total spend rose only 8% as a result, since travel partly displaced the usual dining and entertainment activity.",
    severity: 'INFO',
    priority: 50,
    category: 'SPENDING',
    metadata: {
      dataPoints: { current: 1180, prior: 0, yoy: null, deltaPct: null },
      actionTypes: ['TRAVEL_PLANNING'],
      relatedLenses: ['SPENDING_VELOCITY'],
      suggestedAction: 'If a trip is planned, set the expected total upfront so April can be measured against it.',
    },
  },

  INCOME_STABILITY: {
    lens: 'INCOME_STABILITY',
    title: 'Income Steady at Six-Month Average',
    body: "March income landed at $9,200, within $50 of the trailing 6-month average of $9,150. The expected payroll deposit arrived on schedule, and a small bonus in early March pushed the total slightly above the band. Coefficient of variation across the window is 0.04 — about as stable as income gets.",
    severity: 'POSITIVE',
    priority: 45,
    category: 'INCOME',
    metadata: {
      dataPoints: { current: 9200, prior: 9150, yoy: 8800, deltaPct: 0.5 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['SAVINGS_RATE'],
      suggestedAction: 'Stable income makes this a good time to revisit the savings target for the year.',
    },
  },

  SAVINGS_RATE: {
    lens: 'SAVINGS_RATE',
    title: 'Savings Rate Slipped to 7% in March',
    body: "The savings rate fell from 19% in February to 7% in March, with $640 saved against $9,200 of income. The drop is spending-driven — discretionary categories rose by $1,180 — rather than an income shortfall. Two more months at this pace and the trailing average drops below 10%.",
    severity: 'WARNING',
    priority: 75,
    category: 'SAVINGS',
    metadata: {
      dataPoints: { current: 7, prior: 19, yoy: 14, deltaPct: -63 },
      actionTypes: ['BUDGET_OPTIMIZATION', 'SAVINGS_GOAL'],
      relatedLenses: ['SPENDING_VELOCITY', 'CATEGORY_CONCENTRATION'],
      suggestedAction: 'One option would be capping discretionary spend at the February level through April.',
    },
  },

  DEBT_HEALTH: {
    lens: 'DEBT_HEALTH',
    title: 'Total Debt Down 4% on Principal Payments',
    body: "Total balances fell from $42,800 to $41,090 last month — a $1,710 reduction, of which $1,420 was principal. The weighted interest rate held at 5.2%. Debt servicing was 11% of income, well inside a comfortable range.",
    severity: 'POSITIVE',
    priority: 50,
    category: 'DEBT',
    metadata: {
      dataPoints: { current: 41090, prior: 42800, yoy: 48200, deltaPct: -4 },
      actionTypes: ['DEBT_REDUCTION'],
      relatedLenses: ['NET_WORTH_TRAJECTORY'],
      suggestedAction: 'At this pace the highest-rate balance clears within a year.',
    },
  },

  NET_WORTH_TRAJECTORY: {
    lens: 'NET_WORTH_TRAJECTORY',
    title: 'Net Worth Up $4,280 on Stock Appreciation',
    body: "Net worth rose from $238,400 to $242,680, a 1.8% gain. Stocks were the largest mover at +$3,400, ETFs added another $1,200, and Mortgage principal fell by $720. Real Estate held steady at $42,000 and Crypto drifted up $260. The month's gain was overwhelmingly equity-driven; the rest of the portfolio was quiet.",
    severity: 'POSITIVE',
    priority: 60,
    category: 'NET_WORTH',
    metadata: {
      dataPoints: { current: 242680, prior: 238400, yoy: 218400, deltaPct: 1.8 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['SAVINGS_RATE', 'DEBT_HEALTH'],
      suggestedAction: 'Holding this pace for the year would put net worth roughly $51k higher by next March.',
    },
  },

  NET_WORTH_MILESTONES: {
    lens: 'NET_WORTH_MILESTONES',
    title: 'Crossed the $250k Mark',
    body: "Net worth crossed $250,000 this month, finishing at $252,400. The previous milestone ($100k) was reached 38 months ago; the next ($500k) sits at the current pace roughly 7 years out, assuming the trailing 12-month savings rate holds. Worth marking — these round numbers are a real measure of progress.",
    severity: 'POSITIVE',
    priority: 80,
    category: 'NET_WORTH',
    metadata: {
      dataPoints: { current: 252400, prior: 244100, yoy: 220500, deltaPct: 3.4 },
      actionTypes: ['SAVINGS_GOAL'],
      relatedLenses: ['NET_WORTH_TRAJECTORY'],
      suggestedAction: 'Consider documenting what the next milestone target should mean — a goal turns a number into a plan.',
    },
  },
};

module.exports = { examples };
