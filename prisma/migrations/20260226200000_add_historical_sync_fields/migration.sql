-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN "historicalSyncComplete" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlaidItem" ADD COLUMN "earliestTransactionDate" TIMESTAMP(3);
