-- Tag model: add budget and date fields
ALTER TABLE "Tag" ADD COLUMN "budget" DECIMAL(18, 2);
ALTER TABLE "Tag" ADD COLUMN "startDate" TIMESTAMP(3);
ALTER TABLE "Tag" ADD COLUMN "endDate" TIMESTAMP(3);

-- TagAnalyticsCacheMonthly: new cache table
CREATE TABLE "TagAnalyticsCacheMonthly" (
    "id" SERIAL NOT NULL,
    "tagId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "credit" DECIMAL(18,2) NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagAnalyticsCacheMonthly_pkey" PRIMARY KEY ("id")
);

-- Unique constraint for upsert
CREATE UNIQUE INDEX "tag_tenant_year_month_currency_country_type_group"
  ON "TagAnalyticsCacheMonthly"("tagId", "tenantId", "year", "month", "currency", "country", "type", "group");

-- Lookup indices
CREATE INDEX "TagAnalyticsCacheMonthly_tenantId_idx" ON "TagAnalyticsCacheMonthly"("tenantId");
CREATE INDEX "TagAnalyticsCacheMonthly_tagId_idx" ON "TagAnalyticsCacheMonthly"("tagId");

-- Foreign keys
ALTER TABLE "TagAnalyticsCacheMonthly"
  ADD CONSTRAINT "TagAnalyticsCacheMonthly_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TagAnalyticsCacheMonthly"
  ADD CONSTRAINT "TagAnalyticsCacheMonthly_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
