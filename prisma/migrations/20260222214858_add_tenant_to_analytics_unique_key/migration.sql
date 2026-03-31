/*
  Warnings:

  - A unique constraint covering the columns `[tenantId,year,month,currency,country,type,group]` on the table `AnalyticsCacheMonthly` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "AnalyticsCacheMonthly_year_month_currency_country_type_grou_key";

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsCacheMonthly_tenantId_year_month_currency_country__key" ON "AnalyticsCacheMonthly"("tenantId", "year", "month", "currency", "country", "type", "group");
