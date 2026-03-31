/*
  Warnings:

  - Added the required column `updatedAt` to the `Category` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PortfolioItemKeyStrategy" AS ENUM ('TICKER', 'CATEGORY_NAME', 'CATEGORY_NAME_PLUS_DESCRIPTION', 'IGNORE');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "details" TEXT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "icon" TEXT,
ADD COLUMN     "portfolioItemKeyStrategy" "PortfolioItemKeyStrategy" NOT NULL DEFAULT 'IGNORE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
