module.exports = {
  name: 'SECTOR_CONCENTRATION',
  rubric: `SECTOR_CONCENTRATION
Focus: equity concentration at TWO levels — GICS sector and the industries inside it. KEY SIGNALS provides \`topSector\` (the dominant sector with its share %) AND \`topIndustries\` (the top 3 industries with their share %, parent sector, and constituent symbols). Use both: the sector tells you the breadth of exposure, the industry tells you whether it's diversified across the sector or stacked on one sub-theme.
Severity:
- WARNING:  one sector >40% of equity, OR one industry >25% of equity (single-industry stacking is a stronger flag than spread-across-a-sector concentration).
- INFO:     one sector 25-40%, or sector mix shifted ≥5pp vs prior, or worth describing the industry split inside the dominant sector.
- POSITIVE: a previously concentrated sector or industry now below its threshold.
Always name the dominant industries by name AND list 1-2 of the constituent holdings that drive each one (the symbols are in \`topIndustries[i].holdings\`). Example phrasing: "Technology holds 47%, with Semiconductors alone at 28% — driven by NVDA and AMD." Group ETFs by their stated sector exposure when known. If the user clearly holds a thematic ETF (e.g. tech-only), do not double-flag both the holding and its sector concentration.`,
};
