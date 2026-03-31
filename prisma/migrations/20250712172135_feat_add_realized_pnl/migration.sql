/*
  Warnings:

  - You are about to drop the column `unrealizedPnl` on the `PortfolioAsset` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PortfolioAsset" DROP COLUMN "unrealizedPnl",
ADD COLUMN     "realizedPnL" DECIMAL(18,8) NOT NULL DEFAULT 0;
