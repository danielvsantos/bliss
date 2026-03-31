-- Drop the ImportJob table — the dumb import feature has been retired.
-- All CSV imports now go through the smart import pipeline (StagedImport).
-- The Bliss Native CSV adapter replaces the dumb import for native-format CSVs.

DROP TABLE IF EXISTS "ImportJob";
