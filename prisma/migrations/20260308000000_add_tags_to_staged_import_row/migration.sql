-- Add tags column to StagedImportRow for CSV tag support.
-- Stores a JSON array of tag name strings, e.g. ["Japan 2026", "Business"].
-- Nullable — most rows (especially from non-native adapters) will have no tags.
ALTER TABLE "StagedImportRow" ADD COLUMN "tags" JSONB;
