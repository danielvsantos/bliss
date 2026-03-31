-- Enable pgvector extension (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column (no-op if already exists)
ALTER TABLE "TransactionEmbedding" ADD COLUMN IF NOT EXISTS "embedding" vector(768);

-- IVFFlat cosine index (no-op if already exists)
CREATE INDEX IF NOT EXISTS "TransactionEmbedding_embedding_idx"
  ON "TransactionEmbedding" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- Make transactionId nullable only if it is currently NOT NULL
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'TransactionEmbedding'
      AND column_name = 'transactionId'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "TransactionEmbedding" ALTER COLUMN "transactionId" DROP NOT NULL;
  END IF;
END $$;
