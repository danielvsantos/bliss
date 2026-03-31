-- Add per-category granularity to TagAnalyticsCacheMonthly
-- This is a cache table rebuilt by the analytics worker, so truncate before altering.

TRUNCATE TABLE "TagAnalyticsCacheMonthly";

-- Add category columns
ALTER TABLE "TagAnalyticsCacheMonthly" ADD COLUMN "categoryId" INTEGER NOT NULL;
ALTER TABLE "TagAnalyticsCacheMonthly" ADD COLUMN "categoryName" TEXT NOT NULL;

-- Replace unique constraint: old one without categoryId → new one with categoryId
DROP INDEX "tag_tenant_year_month_currency_country_type_group";
CREATE UNIQUE INDEX "tag_tenant_year_month_currency_country_type_group_cat"
  ON "TagAnalyticsCacheMonthly"("tagId", "tenantId", "year", "month", "currency", "country", "type", "group", "categoryId");

-- Category foreign key
ALTER TABLE "TagAnalyticsCacheMonthly"
  ADD CONSTRAINT "TagAnalyticsCacheMonthly_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
