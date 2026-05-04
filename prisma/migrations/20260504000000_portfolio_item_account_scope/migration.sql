-- Migration: portfolio_item_account_scope
--
-- Adds per-account isolation to PortfolioItem.
-- Key changes:
--   1. Add nullable accountId FK → Account (null = manually-entered asset, no brokerage binding)
--   2. Add hasLotMismatch flag (quantity went negative during FIFO — cross-account close detected)
--   3. Replace @@unique([tenantId, symbol]) with @@unique([tenantId, symbol, accountId])
--      PostgreSQL treats NULLs as distinct in unique constraints, so two manual assets
--      with the same symbol and accountId=NULL are both permitted.
--   4. Delete all non-MANUAL PortfolioItem rows — they will be rebuilt by a full
--      portfolio reprocessing run after this migration. ManualAssetValue + DebtTerms
--      are preserved because their rows cascade from PortfolioItem via FK.
--   5. Add indexes for accountId lookup.

-- Step 1: Add the new columns
ALTER TABLE "PortfolioItem" ADD COLUMN "accountId" INTEGER;
ALTER TABLE "PortfolioItem" ADD COLUMN "hasLotMismatch" BOOLEAN NOT NULL DEFAULT false;

-- Step 2: Add FK constraint to Account
ALTER TABLE "PortfolioItem"
  ADD CONSTRAINT "PortfolioItem_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Step 3: Remove old unique index/constraint
-- Prisma creates @@unique as a bare CREATE UNIQUE INDEX (not ADD CONSTRAINT),
-- so we must DROP INDEX — DROP CONSTRAINT silently no-ops on standalone indexes.
DROP INDEX IF EXISTS "PortfolioItem_tenantId_symbol_key";
ALTER TABLE "PortfolioItem" DROP CONSTRAINT IF EXISTS "PortfolioItem_tenantId_symbol_key";

-- Step 4: Delete all transaction-derived portfolio items.
--         Their child rows (PortfolioValueHistory, PortfolioHolding) will cascade.
--         ManualAssetValue and DebtTerms will also cascade — but MANUAL-source items
--         are preserved below, so those user-entered records survive.
--         SYSTEM-source items (cash) are also rebuilt by the processor.
DELETE FROM "PortfolioItem" WHERE "source" != 'MANUAL';

-- Step 5: Add new unique constraint covering (tenantId, symbol, accountId).
--         NULL accountId rows are each treated as distinct by PostgreSQL.
ALTER TABLE "PortfolioItem"
  ADD CONSTRAINT "PortfolioItem_tenantId_symbol_accountId_key"
  UNIQUE ("tenantId", "symbol", "accountId");

-- Step 6: Add indexes
CREATE INDEX IF NOT EXISTS "PortfolioItem_accountId_idx" ON "PortfolioItem"("accountId");
