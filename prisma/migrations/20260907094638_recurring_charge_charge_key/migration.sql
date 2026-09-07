-- Durable identity key for subscriptions — additive only.
--
-- Safety review (per the embedding-drop trap in the root CLAUDE.md): ONE
-- `ADD COLUMN`, nullable, no default, no data backfill. One additive index.
-- No reference to "embedding". Apply with `prisma migrate deploy` — never
-- `migrate dev` (the shared schema's pgvector columns are managed by raw SQL
-- and `migrate dev`'s auto-diff would propose dropping them).
--
-- `chargeKey` is assigned once at row creation and repointed to the merge
-- target's key on a manual merge. Rows created before this migration keep a
-- NULL `chargeKey`; the detector falls back to `descriptionHash` for those.

-- AlterTable
ALTER TABLE "RecurringCharge" ADD COLUMN "chargeKey" TEXT;

-- CreateIndex
CREATE INDEX "RecurringCharge_tenantId_chargeKey_idx" ON "RecurringCharge"("tenantId", "chargeKey");
