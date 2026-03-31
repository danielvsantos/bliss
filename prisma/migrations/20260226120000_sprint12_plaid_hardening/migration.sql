-- Sprint 12: Plaid Integration Hardening
-- Adds PlaidSyncLog model, enrichment fields to PlaidTransaction, and classificationReasoning

-- PlaidSyncLog model
CREATE TABLE "PlaidSyncLog" (
    "id" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaidSyncLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlaidSyncLog_plaidItemId_createdAt_idx" ON "PlaidSyncLog"("plaidItemId", "createdAt");

ALTER TABLE "PlaidSyncLog" ADD CONSTRAINT "PlaidSyncLog_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New fields on PlaidTransaction
ALTER TABLE "PlaidTransaction" ADD COLUMN "classificationReasoning" TEXT;
ALTER TABLE "PlaidTransaction" ADD COLUMN "requiresEnrichment" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlaidTransaction" ADD COLUMN "enrichmentType" TEXT;
