-- Migration: Sprint B — defaultCategoryCode on Category + GlobalEmbedding table
-- Database was cleared before this migration ran, so no backfill is needed.
-- New tenants receive defaultCategoryCode at signup from defaultCategories.js.

-- Step 1: Add defaultCategoryCode column to Category
ALTER TABLE "Category" ADD COLUMN "defaultCategoryCode" TEXT;

-- Step 2: Create GlobalEmbedding table
CREATE TABLE IF NOT EXISTS "GlobalEmbedding" (
  "id"                  SERIAL PRIMARY KEY,
  "description"         TEXT NOT NULL,
  "defaultCategoryCode" TEXT NOT NULL,
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on description (one global embedding per normalized description)
ALTER TABLE "GlobalEmbedding" ADD CONSTRAINT "GlobalEmbedding_description_key" UNIQUE ("description");

-- Vector column (requires pgvector extension, already enabled from previous migration)
ALTER TABLE "GlobalEmbedding" ADD COLUMN IF NOT EXISTS embedding vector(768);

-- Index on defaultCategoryCode for reverse lookup / regeneration queries
CREATE INDEX IF NOT EXISTS "GlobalEmbedding_defaultCategoryCode_idx" ON "GlobalEmbedding" ("defaultCategoryCode");

-- IVFFlat index for cosine similarity search.
-- NOTE: IVFFlat requires at least ~1000 rows to be effective (lists = 100 means ~10 rows/list).
-- Create this index manually after the first batch of GlobalEmbedding rows is inserted:
--   CREATE INDEX "GlobalEmbedding_embedding_idx"
--   ON "GlobalEmbedding" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
