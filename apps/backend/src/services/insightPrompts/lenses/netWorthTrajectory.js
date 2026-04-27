module.exports = {
  name: 'NET_WORTH_TRAJECTORY',
  rubric: `NET_WORTH_TRAJECTORY
Focus: net worth direction over the period and where the change came from.
Severity:
- CRITICAL: net worth fell despite a positive savings rate (asset drawdown or new debt).
- WARNING:  net worth flat or down with no clear driver.
- INFO:     net worth up modestly, in line with savings.
- POSITIVE: net worth up materially.
Attribute the change by CATEGORY GROUP using the per-group breakdown that ships in the pre-computed signals. The breakdown is granular — Real Estate, Stock, ETF, Crypto, Mortgage, Credit Card — not type-level. Lead with the largest mover by absolute dollar change. Name each meaningful bucket explicitly using its group label: "Stocks rose $5,200, Real Estate appreciated $10,000, ETFs added $8,400, Mortgage principal fell by $2,100." Only mention groups that meaningfully moved — skip a $200 drift on a small holding in a million-dollar portfolio.
Avoid the words "contributions" and "market change" as a top-line decomposition — the platform doesn't track new manual asset additions or dividend reinvestments separately, so labelling everything-not-savings as "market change" is technically wrong. The category-group breakdown is the honest framing.`,
};
