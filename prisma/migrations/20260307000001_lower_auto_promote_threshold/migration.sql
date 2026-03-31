-- Lower the default auto-promote threshold from 0.95 to 0.90.
-- LLM classifications are now hard-capped at 0.85, so only EXACT_MATCH (1.0)
-- and high-confidence VECTOR_MATCH (tenant-scoped) can auto-promote.

-- Update the column default for new tenants
ALTER TABLE "Tenant" ALTER COLUMN "autoPromoteThreshold" SET DEFAULT 0.90;

-- Migrate existing tenants still on the old default
UPDATE "Tenant" SET "autoPromoteThreshold" = 0.90 WHERE "autoPromoteThreshold" = 0.95;
