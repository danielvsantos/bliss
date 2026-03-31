-- Add seedReady flag to PlaidItem and StagedImport.
-- seedReady = true signals the frontend that Phase 1 classification is complete
-- and the Quick Seed interview can be shown (if there are any LLM-classified seeds).
-- Phase 2 (bulk parallel classification) continues non-blocking after seedReady is set.

ALTER TABLE "PlaidItem" ADD COLUMN "seedReady" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "StagedImport" ADD COLUMN "seedReady" BOOLEAN NOT NULL DEFAULT false;
