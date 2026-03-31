/*
  Warnings:

  - You are about to drop the `CategorizedTransaction` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "CategorizedTransaction";

-- CreateTable
CREATE TABLE "CashFlowCacheDaily" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "netFlow" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashFlowCacheDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsCacheDaily" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
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

    CONSTRAINT "AnalyticsCacheDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashFlowCacheDaily_tenantId_idx" ON "CashFlowCacheDaily"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CashFlowCacheDaily_date_currency_tenantId_key" ON "CashFlowCacheDaily"("date", "currency", "tenantId");

-- CreateIndex
CREATE INDEX "AnalyticsCacheDaily_tenantId_idx" ON "AnalyticsCacheDaily"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsCacheDaily_date_currency_country_type_group_tenant_key" ON "AnalyticsCacheDaily"("date", "currency", "country", "type", "group", "tenantId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioItem" ADD CONSTRAINT "PortfolioItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualAssetValue" ADD CONSTRAINT "ManualAssetValue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsCacheMonthly" ADD CONSTRAINT "AnalyticsCacheMonthly_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashFlowCacheDaily" ADD CONSTRAINT "CashFlowCacheDaily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsCacheDaily" ADD CONSTRAINT "AnalyticsCacheDaily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
