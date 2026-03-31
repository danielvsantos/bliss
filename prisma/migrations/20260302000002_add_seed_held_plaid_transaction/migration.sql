-- Add seedHeld flag to PlaidTransaction
-- Marks Phase 1 LLM seeds that are held back from Phase 2 until the user confirms them.
-- Default false: existing rows behave exactly as before.
ALTER TABLE "PlaidTransaction" ADD COLUMN "seedHeld" BOOLEAN NOT NULL DEFAULT false;

-- Index for efficient Phase 2 exclusion query:
-- WHERE processed = false AND promotionStatus = 'PENDING' AND "seedHeld" = false
CREATE INDEX "PlaidTransaction_seedHeld_idx" ON "PlaidTransaction" ("seedHeld");
