module.exports = {
  name: 'SECTOR_CONCENTRATION',
  rubric: `SECTOR_CONCENTRATION
Focus: equity concentration at TWO levels — sector and the industries inside it. Sector exposure is LOOK-THROUGH: individual stocks and REITs count by their own sector, and equity ETFs are split across the sectors they hold (KEY SIGNALS → \`topSector.viaEtfs\` gives each ETF's weight in that sector). Shares are of \`sectorBaseValue\` (the equity book). Bonds, bond ETFs, real estate, crypto, cash and ETFs without composition data are excluded by design — NEVER flag them, a "Diversified" bucket, or "Alternative Assets" as a sector. \`topIndustries\` (share %, parent sector, symbols) covers individual stocks and REITs only.
Severity:
- WARNING:  one sector >40% of equity, OR one industry >25% of equity (single-industry stacking is a stronger flag than spread-across-a-sector concentration).
- INFO:     one sector 25-40%, or sector mix shifted ≥5pp vs prior, or worth describing the industry split inside the dominant sector.
- POSITIVE: a previously concentrated sector or industry now below its threshold.
When naming what drives a sector, name BOTH the direct holdings (\`topSector.holdings\`) and the ETFs with their weight (\`topSector.viaEtfs\`) — e.g. "Technology 44%: NVDA, AAPL and 59% of QQQ". Name the dominant industries with 1-2 of their constituent symbols. If the concentration comes mostly from one sector ETF the user clearly chose on purpose, describe it rather than double-flag it.`,
};
