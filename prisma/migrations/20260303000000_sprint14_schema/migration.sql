-- Sprint 14: Portfolio Engine — Multi-Market Pricing, Fund Automation & Currency Flexibility
--
-- 1. Tenant: Add configurable portfolio display currency
-- 2. Transaction: Add ISIN, exchange, and asset currency for ticker resolution
-- 3. PortfolioItem: Same ticker metadata fields
-- 4. AssetPrice: Add exchange to disambiguate prices across markets

-- Step 1: Tenant — portfolio currency
ALTER TABLE "Tenant" ADD COLUMN "portfolioCurrency" TEXT NOT NULL DEFAULT 'USD';

-- Step 2: Transaction — ticker resolution metadata
ALTER TABLE "Transaction" ADD COLUMN "isin" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "exchange" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "assetCurrency" TEXT;

-- Step 3: PortfolioItem — ticker resolution metadata
ALTER TABLE "PortfolioItem" ADD COLUMN "isin" TEXT;
ALTER TABLE "PortfolioItem" ADD COLUMN "exchange" TEXT;
ALTER TABLE "PortfolioItem" ADD COLUMN "assetCurrency" TEXT;

-- Step 4: AssetPrice — add exchange dimension
ALTER TABLE "AssetPrice" ADD COLUMN "exchange" TEXT NOT NULL DEFAULT '';

-- Step 5: Update unique constraint to include exchange
DROP INDEX "AssetPrice_symbol_assetType_day_currency_key";
CREATE UNIQUE INDEX "AssetPrice_symbol_assetType_day_currency_exchange_key"
  ON "AssetPrice"("symbol", "assetType", "day", "currency", "exchange");
