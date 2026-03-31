-- NOTE: pgvector extension (CREATE EXTENSION vector) and the embedding vector(768) column
-- will be added in a separate migration once pgvector is available on the DB host.
-- The TransactionEmbedding table is created here without the vector column for now.

-- AlterTable
ALTER TABLE "PlaidTransaction" ADD COLUMN     "aiConfidence" DOUBLE PRECISION,
ADD COLUMN     "classificationSource" TEXT,
ADD COLUMN     "promotionStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "suggestedCategoryId" INTEGER;

-- CreateTable
CREATE TABLE "TransactionEmbedding" (
    "id" SERIAL NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "tenantId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportAdapter" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "matchSignature" JSONB NOT NULL,
    "columnMapping" JSONB NOT NULL,
    "dateFormat" TEXT,
    "amountStrategy" TEXT NOT NULL,
    "currencyDefault" TEXT,
    "skipRows" INTEGER NOT NULL DEFAULT 0,
    "tenantId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportAdapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagedImport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "fileName" TEXT NOT NULL,
    "adapterName" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagedImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagedImportRow" (
    "id" TEXT NOT NULL,
    "stagedImportId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawData" JSONB NOT NULL,
    "transactionDate" TIMESTAMP(3),
    "description" TEXT,
    "debit" DECIMAL(18,8),
    "credit" DECIMAL(18,8),
    "currency" TEXT,
    "accountId" INTEGER,
    "suggestedCategoryId" INTEGER,
    "confidence" DOUBLE PRECISION,
    "classificationSource" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "duplicateOfId" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagedImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionEmbedding_transactionId_key" ON "TransactionEmbedding"("transactionId");

-- CreateIndex
CREATE INDEX "TransactionEmbedding_tenantId_idx" ON "TransactionEmbedding"("tenantId");

-- CreateIndex
CREATE INDEX "TransactionEmbedding_categoryId_idx" ON "TransactionEmbedding"("categoryId");

-- CreateIndex
CREATE INDEX "ImportAdapter_tenantId_idx" ON "ImportAdapter"("tenantId");

-- CreateIndex
CREATE INDEX "StagedImport_tenantId_idx" ON "StagedImport"("tenantId");

-- CreateIndex
CREATE INDEX "StagedImport_status_idx" ON "StagedImport"("status");

-- CreateIndex
CREATE INDEX "StagedImportRow_stagedImportId_idx" ON "StagedImportRow"("stagedImportId");

-- CreateIndex
CREATE INDEX "PlaidTransaction_promotionStatus_idx" ON "PlaidTransaction"("promotionStatus");

-- AddForeignKey
ALTER TABLE "TransactionEmbedding" ADD CONSTRAINT "TransactionEmbedding_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionEmbedding" ADD CONSTRAINT "TransactionEmbedding_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionEmbedding" ADD CONSTRAINT "TransactionEmbedding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportAdapter" ADD CONSTRAINT "ImportAdapter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedImport" ADD CONSTRAINT "StagedImport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedImportRow" ADD CONSTRAINT "StagedImportRow_stagedImportId_fkey" FOREIGN KEY ("stagedImportId") REFERENCES "StagedImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- TODO (Sprint 3): Once pgvector is installed on the DB host, run a separate migration:
-- CREATE EXTENSION IF NOT EXISTS vector;
-- ALTER TABLE "TransactionEmbedding" ADD COLUMN "embedding" vector(768);
-- CREATE INDEX "TransactionEmbedding_embedding_idx" ON "TransactionEmbedding" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
