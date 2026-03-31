-- Sprint 17: Transaction Export & CSV Update
-- Adds support for updating existing transactions via CSV round-trip import

-- StagedImport: track how many rows are updates vs creates
ALTER TABLE "StagedImport" ADD COLUMN "updateCount" INTEGER NOT NULL DEFAULT 0;

-- StagedImportRow: link update rows to their target transaction + store computed diff
ALTER TABLE "StagedImportRow" ADD COLUMN "updateTargetId" INTEGER;
ALTER TABLE "StagedImportRow" ADD COLUMN "updateDiff" JSONB;
