-- Equity Analysis: asset class breakdown & ETF look-through (#79) — all additive.
--
-- Safety review (per CLAUDE.md): this migration contains ONLY nullable
-- ADD COLUMN IF NOT EXISTS statements. There is NO reference to "embedding",
-- NO DROP / ALTER TYPE / data backfill. Apply with `prisma migrate deploy`.

-- AlterTable: per-item asset class override (one of @bliss/shared/portfolio ASSET_CLASSES; NULL = automatic)
ALTER TABLE "PortfolioItem" ADD COLUMN IF NOT EXISTS "assetClassOverride" TEXT;

-- AlterTable: weekly ETF composition from Twelve Data /etfs/world/composition
ALTER TABLE "SecurityMaster" ADD COLUMN IF NOT EXISTS "etfComposition" JSONB,
    ADD COLUMN IF NOT EXISTS "lastCompositionUpdate" TIMESTAMP(3);
