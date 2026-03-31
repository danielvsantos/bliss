-- AlterTable: add plaidHistoryDays to Tenant
-- Defaults to 1 (single day) for all existing tenants.
-- New tenants will have this seeded from PLAID_HISTORY_DAYS env var at creation time.
ALTER TABLE "Tenant" ADD COLUMN "plaidHistoryDays" INTEGER NOT NULL DEFAULT 1;
