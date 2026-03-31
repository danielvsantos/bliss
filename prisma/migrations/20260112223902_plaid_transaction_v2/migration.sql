/*
  Warnings:

  - A unique constraint covering the columns `[institutionId]` on the table `Bank` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[externalId]` on the table `Transaction` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `plaidAccountId` to the `PlaidTransaction` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Bank" ADD COLUMN     "institutionId" TEXT;

-- AlterTable
ALTER TABLE "PlaidTransaction" ADD COLUMN     "pendingTransactionId" TEXT,
ADD COLUMN     "plaidAccountId" TEXT NOT NULL,
ADD COLUMN     "rawJson" TEXT,
ADD COLUMN     "syncType" TEXT NOT NULL DEFAULT 'ADDED';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL';

-- CreateIndex
CREATE UNIQUE INDEX "Bank_institutionId_key" ON "Bank"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_externalId_key" ON "Transaction"("externalId");
