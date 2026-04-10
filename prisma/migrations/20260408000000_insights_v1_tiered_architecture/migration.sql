-- AlterTable: Add tiered insight fields
ALTER TABLE "Insight" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'DAILY';
ALTER TABLE "Insight" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'SPENDING';
ALTER TABLE "Insight" ADD COLUMN "periodKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Insight" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Backfill existing insights: map lens to category, set tier=DAILY
UPDATE "Insight" SET
  "tier" = 'DAILY',
  "category" = CASE
    WHEN "lens" IN ('SPENDING_VELOCITY', 'CATEGORY_CONCENTRATION') THEN 'SPENDING'
    WHEN "lens" = 'INCOME_STABILITY' THEN 'INCOME'
    WHEN "lens" = 'SAVINGS_RATE' THEN 'SAVINGS'
    WHEN "lens" = 'PORTFOLIO_EXPOSURE' THEN 'PORTFOLIO'
    WHEN "lens" = 'DEBT_HEALTH' THEN 'DEBT'
    WHEN "lens" = 'NET_WORTH_TRAJECTORY' THEN 'NET_WORTH'
    ELSE 'SPENDING'
  END,
  "periodKey" = TO_CHAR("date", 'YYYY-MM-DD'),
  "expiresAt" = "createdAt" + INTERVAL '90 days';

-- CreateIndex
CREATE INDEX "Insight_tenantId_tier_periodKey_idx" ON "Insight"("tenantId", "tier", "periodKey");
CREATE INDEX "Insight_tenantId_category_idx" ON "Insight"("tenantId", "category");
CREATE INDEX "Insight_expiresAt_idx" ON "Insight"("expiresAt");
