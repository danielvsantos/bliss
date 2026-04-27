/**
 * L2 — MONTHLY tier addendum.
 *
 * Concatenated after L1 in the system message. Should add only what's
 * distinctive about the monthly cadence — length, comparison expectations,
 * and the "anchor every observation to a MoM delta" rule.
 */

function buildTierAddendum() {
  return `TIER: Monthly review for a closed calendar month.
- Treat this as a health check, not a deep dive.
- Compare to prior month always; to same month last year when YoY is available.
- Each body: 2-3 sentences with 4-6 numbers.
- Anchor every insight to a month-over-month delta when prior is available. If prior is unavailable, anchor to the month's own internals (top movers, share-of-spend, savings rate).
- Title: ≤8 words.`;
}

module.exports = { buildTierAddendum };
