-- Manual rename for subscriptions — additive only.
--
-- Safety review (per prisma/CLAUDE.md): ONE `ADD COLUMN`, NOT NULL with a
-- constant default (safe — Postgres backfills the default without a table
-- rewrite for a boolean). No data migration. No reference to "embedding".
-- Apply with `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "RecurringCharge" ADD COLUMN "userLabelLocked" BOOLEAN NOT NULL DEFAULT false;
