-- Move AI classification threshold settings from User to Tenant
-- These are business rules for the whole organisation, not per-user preferences.

-- Add columns to Tenant (with the same defaults as were on User)
ALTER TABLE "Tenant" ADD COLUMN "autoPromoteThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.95;
ALTER TABLE "Tenant" ADD COLUMN "reviewThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.70;

-- Drop columns from User (existing data is discarded; defaults are reinstated on Tenant)
ALTER TABLE "User" DROP COLUMN IF EXISTS "autoPromoteThreshold";
ALTER TABLE "User" DROP COLUMN IF EXISTS "reviewThreshold";
