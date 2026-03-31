/*
  Warnings:

  - You are about to drop the column `portfolioAssetId` on the `PortfolioHolding` table. All the data in the column will be lost.
  - You are about to drop the `PortfolioAsset` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PortfolioLot` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `portfolioItemId` to the `PortfolioHolding` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "DebtTerms" DROP CONSTRAINT "DebtTerms_assetId_fkey";

-- DropForeignKey
ALTER TABLE "ManualAssetValue" DROP CONSTRAINT "ManualAssetValue_assetId_fkey";

-- DropForeignKey
ALTER TABLE "PortfolioAsset" DROP CONSTRAINT "PortfolioAsset_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "PortfolioHolding" DROP CONSTRAINT "PortfolioHolding_portfolioAssetId_fkey";

-- DropForeignKey
ALTER TABLE "PortfolioLot" DROP CONSTRAINT "PortfolioLot_assetId_fkey";

-- DropForeignKey
ALTER TABLE "PortfolioValueHistory" DROP CONSTRAINT "PortfolioValueHistory_assetId_fkey";

-- DropIndex
DROP INDEX "PortfolioHolding_portfolioAssetId_idx";

-- AlterTable
ALTER TABLE "PortfolioHolding" DROP COLUMN "portfolioAssetId",
ADD COLUMN     "portfolioItemId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "portfolioItemId" INTEGER;

-- DropTable
DROP TABLE "PortfolioAsset";

-- DropTable
DROP TABLE "PortfolioLot";

-- CreateTable
CREATE TABLE "PortfolioItem" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "symbol" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "details" TEXT,
    "costBasis" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "realizedPnL" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioItem_tenantId_symbol_key" ON "PortfolioItem"("tenantId", "symbol");

-- CreateIndex
CREATE INDEX "PortfolioHolding_portfolioItemId_idx" ON "PortfolioHolding"("portfolioItemId");

-- CreateIndex
CREATE INDEX "Transaction_portfolioItemId_idx" ON "Transaction"("portfolioItemId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "PortfolioItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioItem" ADD CONSTRAINT "PortfolioItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioValueHistory" ADD CONSTRAINT "PortfolioValueHistory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualAssetValue" ADD CONSTRAINT "ManualAssetValue_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioHolding" ADD CONSTRAINT "PortfolioHolding_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "PortfolioItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtTerms" ADD CONSTRAINT "DebtTerms_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
