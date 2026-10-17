-- Manual "split by amount" for subscriptions (#138) — additive only.
--
-- When true, the row is a split marker: the detector splits that merchant's (or
-- amount band's) charges into one row per distinct recurring amount, and the
-- marker itself produces nothing (hidden from Active/Lapsed, shown under "All"
-- with an Unsplit action).
--
-- Safety: ONE `ADD COLUMN`, NOT NULL with a constant default (no table rewrite
-- for a boolean). Idempotent. No data migration. No reference to "embedding".
-- Apply with `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "RecurringCharge" ADD COLUMN IF NOT EXISTS "splitByAmount" BOOLEAN NOT NULL DEFAULT false;
