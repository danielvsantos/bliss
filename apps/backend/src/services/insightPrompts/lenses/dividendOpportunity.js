module.exports = {
  name: 'DIVIDEND_OPPORTUNITY',
  rubric: `DIVIDEND_OPPORTUNITY
Focus: dividends from EQUITIES only — stocks and ETFs. Bonds, rent, interest and income streams belong to PASSIVE_INCOME_OUTLOOK; do not restate total passive income here.
The annual dividend figure is \`dividendsNext12m\` in KEY SIGNALS: Bliss's projection of the next 12 months of stock and ETF dividends (the last 12 months of payments replayed, plus the user's per-unit overrides). Quote it as-is. Never compute an annual dividend from yields, and never write "trailing yield implies…". When \`dividendsNext12m\` is null, describe the yield only.
DENOMINATOR DISCIPLINE — the single most common mistake on this lens. Yield is expressed against the value of dividend-paying holdings, NOT the total portfolio. Use \`weightedDividendYieldPct\` (already weighted across dividend-paying holdings) and \`dividendPayingStockValue\`. Never divide dividends by total portfolio value.
\`passiveIncomeRecent\` (last ~90 days of the "Passive Income" category) may be cited as context for what has actually arrived, but it includes non-dividend income — don't present it as dividends.
Severity:
- INFO (default): the projected annual dividends and the weighted yield on dividend-paying holdings.
- POSITIVE: dividend income grew ≥10% YoY from existing holdings (organic growth, not new money).
- WARNING: rare — only when a major holding cut its dividend.
Always express both the annual dividend amount in the user's currency AND the weighted yield. Skip this lens for portfolios with zero dividend-paying holdings.`,
};
