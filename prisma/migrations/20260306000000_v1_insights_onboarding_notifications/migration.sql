-- v1 Final Features: Insights, Onboarding, Notification Center

-- ============================================================
-- 1. Enhance Insight model
-- ============================================================

-- Rename existing columns
ALTER TABLE "Insight" RENAME COLUMN "description" TO "body";
ALTER TABLE "Insight" RENAME COLUMN "type" TO "lens";

-- Change body to TEXT type
ALTER TABLE "Insight" ALTER COLUMN "body" TYPE TEXT;

-- Change date to DATE type
ALTER TABLE "Insight" ALTER COLUMN "date" TYPE DATE;

-- Add new columns with defaults
ALTER TABLE "Insight" ADD COLUMN "batchId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Insight" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'INFO';
ALTER TABLE "Insight" ADD COLUMN "dataHash" TEXT;
ALTER TABLE "Insight" ADD COLUMN "dismissed" BOOLEAN NOT NULL DEFAULT false;

-- Set default for priority (existing rows keep their value)
ALTER TABLE "Insight" ALTER COLUMN "priority" SET DEFAULT 50;

-- Add tenant relation (foreign key + cascade delete)
ALTER TABLE "Insight" ADD CONSTRAINT "Insight_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create indices for Insight
CREATE INDEX "Insight_tenantId_date_idx" ON "Insight"("tenantId", "date");
CREATE INDEX "Insight_tenantId_batchId_idx" ON "Insight"("tenantId", "batchId");

-- ============================================================
-- 2. Add onboarding fields to Tenant
-- ============================================================

ALTER TABLE "Tenant" ADD COLUMN "onboardingProgress" JSONB;
ALTER TABLE "Tenant" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);

-- ============================================================
-- 3. Add notification field to User
-- ============================================================

ALTER TABLE "User" ADD COLUMN "lastNotificationSeenAt" TIMESTAMP(3);
