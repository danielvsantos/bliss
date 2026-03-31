-- DropIndex (replaced by unique constraint)
DROP INDEX IF EXISTS "PortfolioHolding_portfolioItemId_idx";

-- CreateIndex (unique constraint replaces the old non-unique index)
CREATE UNIQUE INDEX "PortfolioHolding_portfolioItemId_date_key" ON "PortfolioHolding"("portfolioItemId", "date");

-- DropIndex (replaced by unique constraint)
DROP INDEX IF EXISTS "PortfolioValueHistory_assetId_date_idx";

-- CreateIndex (unique constraint replaces the old composite index)
CREATE UNIQUE INDEX "PortfolioValueHistory_assetId_date_source_key" ON "PortfolioValueHistory"("assetId", "date", "source");
