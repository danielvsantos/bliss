-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'AI');

-- CreateEnum
CREATE TYPE "ValueSource" AS ENUM ('Manual', 'Synced', 'AI_Estimated', 'API_ALPHAVANTAGE');

-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('SELF', 'PARTNER', 'CHILD', 'OTHER_RELATIVE', 'FRIEND', 'COLLEAGUE', 'OTHER', 'OTHER2');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "passwordHash" TEXT,
    "passwordSalt" TEXT,
    "provider" TEXT,
    "providerId" TEXT,
    "name" TEXT,
    "profilePictureUrl" TEXT,
    "birthDate" TIMESTAMP(3),
    "relationshipType" "RelationshipType",
    "preferredLocale" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankId" INTEGER NOT NULL,
    "countryId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountOwner" (
    "accountId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "AccountOwner_pkey" PRIMARY KEY ("accountId","userId")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "processingHint" TEXT,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" SERIAL NOT NULL,
    "transaction_date" TIMESTAMP(3) NOT NULL,
    "year" INTEGER NOT NULL,
    "quarter" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "details" TEXT,
    "credit" DECIMAL(18,8),
    "debit" DECIMAL(18,8),
    "currency" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "assetQuantity" DECIMAL(18,8),
    "assetPrice" DECIMAL(18,8),
    "ticker" TEXT,
    "userId" TEXT,
    "tenantId" TEXT NOT NULL,
    "userActionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionTag" (
    "transactionId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,

    CONSTRAINT "TransactionTag_pkey" PRIMARY KEY ("transactionId","tagId")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "color" TEXT,
    "emoji" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategorizedTransaction" (
    "id" TEXT NOT NULL,
    "transaction_date" TIMESTAMP(3) NOT NULL,
    "year" INTEGER NOT NULL,
    "quarter" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "categoryLabel" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "details" TEXT,
    "credit" DECIMAL(18,8),
    "debit" DECIMAL(18,8),
    "currency" TEXT NOT NULL,
    "accountLabel" TEXT NOT NULL,
    "numOfShares" DECIMAL(18,8),
    "price" DECIMAL(18,8),
    "ticker" TEXT,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategorizedTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetPrice" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "price" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrencyRate" (
    "id" SERIAL NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "currencyFrom" TEXT NOT NULL,
    "currencyTo" TEXT NOT NULL,
    "value" DECIMAL(18,8) NOT NULL,
    "provider" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurrencyRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioAsset" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "symbol" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "currentValue" DECIMAL(18,8) NOT NULL,
    "source" TEXT NOT NULL,
    "details" TEXT,
    "costBasis" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "unrealizedPnl" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioLot" (
    "id" SERIAL NOT NULL,
    "assetId" INTEGER NOT NULL,
    "acquisitionDate" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(18,8) NOT NULL,
    "acquisitionValue" DECIMAL(18,8) NOT NULL,
    "acquisitionPrice" DECIMAL(18,8),
    "currency" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioValueHistory" (
    "id" SERIAL NOT NULL,
    "assetId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "nativeValue" DECIMAL(18,8) NOT NULL,
    "nativeCurrency" TEXT NOT NULL,
    "valueInUSD" DECIMAL(18,8) NOT NULL,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioValueHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualAssetValue" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assetId" INTEGER NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "ManualAssetValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioHolding" (
    "id" SERIAL NOT NULL,
    "portfolioAssetId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(18,8) NOT NULL,
    "totalValue" DECIMAL(18,8) NOT NULL,
    "costBasis" DECIMAL(18,8) NOT NULL,

    CONSTRAINT "PortfolioHolding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebtTerms" (
    "id" SERIAL NOT NULL,
    "assetId" INTEGER NOT NULL,
    "interestRate" DECIMAL(9,5) NOT NULL,
    "termInMonths" INTEGER,
    "originationDate" TIMESTAMP(3) NOT NULL,
    "initialBalance" DECIMAL(18,8) NOT NULL,

    CONSTRAINT "DebtTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsCacheMonthly" (
    "id" SERIAL NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsCacheMonthly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "table" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Country" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Currency" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Currency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantCountry" (
    "tenantId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantCountry_pkey" PRIMARY KEY ("tenantId","countryId")
);

-- CreateTable
CREATE TABLE "TenantCurrency" (
    "tenantId" TEXT NOT NULL,
    "currencyId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantCurrency_pkey" PRIMARY KEY ("tenantId","currencyId")
);

-- CreateTable
CREATE TABLE "Bank" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantBank" (
    "tenantId" TEXT NOT NULL,
    "bankId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantBank_pkey" PRIMARY KEY ("tenantId","bankId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_provider_providerId_idx" ON "User"("provider", "providerId");

-- CreateIndex
CREATE INDEX "Account_name_idx" ON "Account"("name");

-- CreateIndex
CREATE INDEX "Account_bankId_idx" ON "Account"("bankId");

-- CreateIndex
CREATE INDEX "Account_countryId_idx" ON "Account"("countryId");

-- CreateIndex
CREATE INDEX "Account_currencyCode_idx" ON "Account"("currencyCode");

-- CreateIndex
CREATE INDEX "Account_tenantId_idx" ON "Account"("tenantId");

-- CreateIndex
CREATE INDEX "Category_group_idx" ON "Category"("group");

-- CreateIndex
CREATE INDEX "Category_type_idx" ON "Category"("type");

-- CreateIndex
CREATE INDEX "Category_tenantId_idx" ON "Category"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_tenantId_key" ON "Category"("name", "tenantId");

-- CreateIndex
CREATE INDEX "Transaction_year_idx" ON "Transaction"("year");

-- CreateIndex
CREATE INDEX "Transaction_month_idx" ON "Transaction"("month");

-- CreateIndex
CREATE INDEX "Transaction_tenantId_idx" ON "Transaction"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_tenantId_name_key" ON "Tag"("tenantId", "name");

-- CreateIndex
CREATE INDEX "CategorizedTransaction_tenantId_idx" ON "CategorizedTransaction"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetPrice_symbol_assetType_day_currency_key" ON "AssetPrice"("symbol", "assetType", "day", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "CurrencyRate_year_month_day_currencyFrom_currencyTo_key" ON "CurrencyRate"("year", "month", "day", "currencyFrom", "currencyTo");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioAsset_tenantId_symbol_key" ON "PortfolioAsset"("tenantId", "symbol");

-- CreateIndex
CREATE INDEX "PortfolioLot_assetId_idx" ON "PortfolioLot"("assetId");

-- CreateIndex
CREATE INDEX "PortfolioValueHistory_assetId_date_idx" ON "PortfolioValueHistory"("assetId", "date");

-- CreateIndex
CREATE INDEX "ManualAssetValue_assetId_idx" ON "ManualAssetValue"("assetId");

-- CreateIndex
CREATE INDEX "ManualAssetValue_tenantId_idx" ON "ManualAssetValue"("tenantId");

-- CreateIndex
CREATE INDEX "PortfolioHolding_portfolioAssetId_idx" ON "PortfolioHolding"("portfolioAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "DebtTerms_assetId_key" ON "DebtTerms"("assetId");

-- CreateIndex
CREATE INDEX "AnalyticsCacheMonthly_tenantId_idx" ON "AnalyticsCacheMonthly"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsCacheMonthly_year_month_currency_country_type_grou_key" ON "AnalyticsCacheMonthly"("year", "month", "currency", "country", "type", "group");

-- CreateIndex
CREATE INDEX "TenantCountry_countryId_idx" ON "TenantCountry"("countryId");

-- CreateIndex
CREATE INDEX "TenantCountry_tenantId_idx" ON "TenantCountry"("tenantId");

-- CreateIndex
CREATE INDEX "TenantCurrency_currencyId_idx" ON "TenantCurrency"("currencyId");

-- CreateIndex
CREATE INDEX "TenantCurrency_tenantId_idx" ON "TenantCurrency"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_name_key" ON "Bank"("name");

-- CreateIndex
CREATE INDEX "TenantBank_bankId_idx" ON "TenantBank"("bankId");

-- CreateIndex
CREATE INDEX "TenantBank_tenantId_idx" ON "TenantBank"("tenantId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "Currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountOwner" ADD CONSTRAINT "AccountOwner_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountOwner" ADD CONSTRAINT "AccountOwner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionTag" ADD CONSTRAINT "TransactionTag_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionTag" ADD CONSTRAINT "TransactionTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioLot" ADD CONSTRAINT "PortfolioLot_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioValueHistory" ADD CONSTRAINT "PortfolioValueHistory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualAssetValue" ADD CONSTRAINT "ManualAssetValue_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioHolding" ADD CONSTRAINT "PortfolioHolding_portfolioAssetId_fkey" FOREIGN KEY ("portfolioAssetId") REFERENCES "PortfolioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtTerms" ADD CONSTRAINT "DebtTerms_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantCountry" ADD CONSTRAINT "TenantCountry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantCountry" ADD CONSTRAINT "TenantCountry_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantCurrency" ADD CONSTRAINT "TenantCurrency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantCurrency" ADD CONSTRAINT "TenantCurrency_currencyId_fkey" FOREIGN KEY ("currencyId") REFERENCES "Currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantBank" ADD CONSTRAINT "TenantBank_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantBank" ADD CONSTRAINT "TenantBank_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
