/*
  Warnings:

  - You are about to drop the column `assetType` on the `PortfolioAsset` table. All the data in the column will be lost.
  - Added the required column `categoryId` to the `PortfolioAsset` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "PortfolioAsset" DROP COLUMN "assetType",
ADD COLUMN     "categoryId" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "PortfolioAsset" ADD CONSTRAINT "PortfolioAsset_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
