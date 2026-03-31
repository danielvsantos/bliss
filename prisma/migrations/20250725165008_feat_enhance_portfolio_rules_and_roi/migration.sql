-- DropForeignKey
ALTER TABLE "DebtTerms" DROP CONSTRAINT "DebtTerms_assetId_fkey";

-- DropForeignKey
ALTER TABLE "PortfolioHolding" DROP CONSTRAINT "PortfolioHolding_portfolioItemId_fkey";

-- DropForeignKey
ALTER TABLE "PortfolioValueHistory" DROP CONSTRAINT "PortfolioValueHistory_assetId_fkey";

-- AlterTable
ALTER TABLE "PortfolioItem" ADD COLUMN     "totalInvested" DECIMAL(18,8);

-- AddForeignKey
ALTER TABLE "PortfolioValueHistory" ADD CONSTRAINT "PortfolioValueHistory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioHolding" ADD CONSTRAINT "PortfolioHolding_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "PortfolioItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtTerms" ADD CONSTRAINT "DebtTerms_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
