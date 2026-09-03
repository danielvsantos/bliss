-- Manual merge for subscriptions — additive only.
--
-- Safety review (per prisma/CLAUDE.md): ONE `ADD COLUMN`, nullable, no default,
-- no data backfill. No reference to "embedding". Apply with `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "RecurringCharge" ADD COLUMN "mergedIntoHash" TEXT;
