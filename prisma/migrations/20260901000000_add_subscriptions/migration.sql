-- Subscriptions & recurring charges — all additive.
--
-- Safety review (per prisma/CLAUDE.md): this migration contains ONLY
--   * CREATE TYPE   (4 new enums)
--   * CREATE TABLE  ("RecurringCharge")
--   * ADD COLUMN    (2 columns, both defaulted/nullable)
--   * CREATE INDEX / ADD FOREIGN KEY for the new table
-- There is NO reference to "embedding", NO DROP / ALTER TYPE / data backfill,
-- and NO change to any existing column. Apply with `prisma migrate deploy`.

-- CreateEnum
CREATE TYPE "RecurringChargeState" AS ENUM ('DETECTED', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RecurringChargeCadence" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "RecurringChargeStatus" AS ENUM ('ACTIVE', 'LAPSED');

-- CreateEnum
CREATE TYPE "RecurringDetectionReason" AS ENUM ('CATEGORY_SIGNAL', 'INTERVAL_HEURISTIC', 'USER_CONFIRMED');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN "isRecurring" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "subscriptionsFullScanAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RecurringCharge" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "descriptionHash" TEXT NOT NULL,
    "merchantLabel" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "state" "RecurringChargeState" NOT NULL DEFAULT 'DETECTED',
    "cadence" "RecurringChargeCadence",
    "userCadenceLocked" BOOLEAN NOT NULL DEFAULT false,
    "status" "RecurringChargeStatus" NOT NULL DEFAULT 'ACTIVE',
    "detectionReason" "RecurringDetectionReason",
    "amount" DECIMAL(18,8),
    "currency" TEXT,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "firstChargedAt" TIMESTAMP(3),
    "lastChargedAt" TIMESTAMP(3),
    "nextExpectedAt" TIMESTAMP(3),
    "lastDetectedAt" TIMESTAMP(3),
    "contributingTransactionIds" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecurringCharge_tenantId_descriptionHash_key" ON "RecurringCharge"("tenantId", "descriptionHash");

-- CreateIndex
CREATE INDEX "RecurringCharge_tenantId_idx" ON "RecurringCharge"("tenantId");

-- CreateIndex
CREATE INDEX "RecurringCharge_tenantId_status_idx" ON "RecurringCharge"("tenantId", "status");

-- CreateIndex
CREATE INDEX "RecurringCharge_tenantId_categoryId_idx" ON "RecurringCharge"("tenantId", "categoryId");

-- AddForeignKey
ALTER TABLE "RecurringCharge" ADD CONSTRAINT "RecurringCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringCharge" ADD CONSTRAINT "RecurringCharge_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
