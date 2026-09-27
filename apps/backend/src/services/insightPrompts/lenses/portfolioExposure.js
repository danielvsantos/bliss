module.exports = {
  name: 'PORTFOLIO_EXPOSURE',
  rubric: `PORTFOLIO_EXPOSURE
Focus: the asset-class mix of the investment portfolio and the top 3 holdings by weight. KEY SIGNALS → \`assetClassAllocation\` lists each class with its % of portfolio value: STOCK, INDEX_ETF, SECTOR_ETF, BOND_ETF, REIT, FUND, GOV_BOND, CORP_BOND, REAL_ESTATE, CRYPTO, OTHER (cash is excluded). Use these classes — never invent buckets such as "ETFs & Funds" or "Alternative Assets". Equity = STOCK + INDEX_ETF + SECTOR_ETF + REIT; fixed income = BOND_ETF + GOV_BOND + CORP_BOND.
When \`fixedIncome\` is present (direct bonds with income terms), describe it in one clause: total face value, weighted coupon, average years to maturity, and the government vs corporate split.
Severity:
- WARNING:  equity >95% of the portfolio, OR a single holding >25% of total, OR a single non-equity class (e.g. REAL_ESTATE, CRYPTO) >60%.
- INFO:     mix shifted ≥5pp in any class vs prior week, or a plain description of the current shape.
- POSITIVE: mix moved toward a stated target (only when one is provided).
Never recommend a target mix or rebalance — describe the current shape and let the user decide.`,
};
