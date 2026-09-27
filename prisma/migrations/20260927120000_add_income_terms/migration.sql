-- Passive Income Projection (#77) — all additive.
--
-- Safety review (per CLAUDE.md): this migration contains ONLY
--   * CREATE TYPE   (3 new enums)
--   * CREATE TABLE  ("IncomeTerms") + indexes, foreign keys and a CHECK constraint
--   * ADD COLUMN    ("SecurityMaster"."recentDividends", nullable)
-- There is NO reference to "embedding", NO DROP / ALTER TYPE / data backfill,
-- and NO change to any existing column. Apply with `prisma migrate deploy`.

-- CreateEnum
CREATE TYPE "IncomeType" AS ENUM ('DIVIDEND', 'FIXED_COUPON', 'FLOATING_COUPON', 'INFLATION_LINKED', 'RENT', 'INTEREST', 'CUSTOM_YIELD', 'FIXED_AMOUNT', 'NONE');

-- CreateEnum
CREATE TYPE "IncomeFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'AT_MATURITY');

-- CreateEnum
CREATE TYPE "BondIssuerType" AS ENUM ('GOVERNMENT', 'CORPORATE');

-- AlterTable: SecurityMaster last-12-month dividend history (R7.1)
ALTER TABLE "SecurityMaster" ADD COLUMN IF NOT EXISTS "recentDividends" JSONB;

-- CreateTable
CREATE TABLE "IncomeTerms" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" INTEGER,
    "categoryId" INTEGER,
    "name" TEXT,
    "orphanedAt" TIMESTAMP(3),
    "orphanedLabel" TEXT,
    "incomeType" "IncomeType" NOT NULL,
    "frequency" "IncomeFrequency",
    "currency" TEXT,
    "anchorPaymentDate" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isDistributing" BOOLEAN NOT NULL DEFAULT true,
    "amountPerPayment" DECIMAL(18,8),
    "dividendPerUnit" DECIMAL(18,8),
    "yieldPct" DECIMAL(9,5),
    "issuerType" "BondIssuerType",
    "faceValuePerUnit" DECIMAL(18,8),
    "couponRate" DECIMAL(9,5),
    "referenceIndex" TEXT,
    "spread" DECIMAL(9,5),
    "assumedIndexRate" DECIMAL(9,5),
    "maturityDate" TIMESTAMP(3),
    "monthlyRent" DECIMAL(18,8),
    "leaseEndDate" TIMESTAMP(3),
    "annualIndexationPct" DECIMAL(9,5),
    "apyPct" DECIMAL(9,5),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomeTerms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (Postgres allows multiple NULLs in a unique index, so streams and detached rows are unaffected)
CREATE UNIQUE INDEX "IncomeTerms_assetId_key" ON "IncomeTerms"("assetId");

-- CreateIndex
CREATE INDEX "IncomeTerms_tenantId_idx" ON "IncomeTerms"("tenantId");

-- CreateIndex
CREATE INDEX "IncomeTerms_categoryId_idx" ON "IncomeTerms"("categoryId");

-- AddForeignKey
ALTER TABLE "IncomeTerms" ADD CONSTRAINT "IncomeTerms_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeTerms" ADD CONSTRAINT "IncomeTerms_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeTerms" ADD CONSTRAINT "IncomeTerms_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Owner CHECK (Prisma cannot express it): exactly one owner, or detached with orphanedAt set.
ALTER TABLE "IncomeTerms" ADD CONSTRAINT "IncomeTerms_owner_check" CHECK (
  (("assetId" IS NOT NULL)::int + ("categoryId" IS NOT NULL)::int) = 1
  OR ("assetId" IS NULL AND "categoryId" IS NULL AND "orphanedAt" IS NOT NULL)
);
