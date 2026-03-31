/*
  Warnings:

  - A unique constraint covering the columns `[tenantId,description]` on the table `TransactionEmbedding` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "TransactionEmbedding" ALTER COLUMN "transactionId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TransactionEmbedding_tenantId_description_key" ON "TransactionEmbedding"("tenantId", "description");
