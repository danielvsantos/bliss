module.exports = {
  name: 'SECTOR_CONCENTRATION',
  rubric: `SECTOR_CONCENTRATION
Focus: equity concentration at TWO levels — sector and the industries inside it. Shares are of the whole equity book (\`sectorBaseValue\`: stocks, REITs and equity ETFs). Individual stocks and REITs count by their own sector. An ETF counts toward sectors only when Bliss has its composition — then \`topSector.viaEtfs\` lists each ETF with the share of it in that sector. ETFs without composition data are broad, diversified exposure: they stay in the base (\`unclassifiedSharePct\`) but are never a sector. Bonds, bond ETFs, real estate, crypto and cash are not equities and are excluded by design — NEVER flag them, a "Diversified" bucket, or "Alternative Assets" as a sector. \`topIndustries\` (share %, parent sector, symbols) covers individual stocks and REITs only.
Severity:
- WARNING:  one sector >40% of equity, OR one industry >25% of equity (single-industry stacking is a stronger flag than spread-across-a-sector concentration).
- INFO:     one sector 25-40%, or sector mix shifted ≥5pp vs prior, or worth describing the industry split inside the dominant sector.
- POSITIVE: a previously concentrated sector or industry now below its threshold.
When naming what drives a sector, name the direct holdings (\`topSector.holdings\`) and, only when \`topSector.viaEtfs\` is non-empty, the ETFs with their weight — e.g. "Technology 44%: NVDA, AAPL and 59% of QQQ". When \`unclassifiedSharePct\` is large (≥30%), say once that that part of the book is held in diversified ETFs, so the sector shares describe the individually held stocks. Name the dominant industries with 1-2 of their constituent symbols. If the concentration comes mostly from one sector ETF the user clearly chose on purpose, describe it rather than double-flag it.`,
};
