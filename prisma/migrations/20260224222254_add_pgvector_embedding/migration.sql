-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to TransactionEmbedding table
ALTER TABLE "TransactionEmbedding" ADD COLUMN IF NOT EXISTS "embedding" vector(768);

-- Create IVFFlat index for cosine similarity search
CREATE INDEX IF NOT EXISTS "TransactionEmbedding_embedding_idx"
  ON "TransactionEmbedding" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
