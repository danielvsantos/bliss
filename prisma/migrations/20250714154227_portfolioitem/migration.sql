/*
  Warnings:

  - You are about to drop the column `description` on the `PortfolioItem` table. All the data in the column will be lost.
  - You are about to drop the column `details` on the `PortfolioItem` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PortfolioItem" DROP COLUMN "description",
DROP COLUMN "details",
ADD COLUMN     "currentValue" DECIMAL(18,8) NOT NULL DEFAULT 0,
ADD COLUMN     "quantity" DECIMAL(18,8) NOT NULL DEFAULT 0,
ADD COLUMN     "realizedPnl" DECIMAL(18,8) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "PortfolioItem_tenantId_idx" ON "PortfolioItem"("tenantId");
