-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "mask" TEXT,
ADD COLUMN     "plaidAccountId" TEXT,
ADD COLUMN     "plaidItemId" TEXT,
ADD COLUMN     "subtype" TEXT,
ADD COLUMN     "type" TEXT;

-- CreateTable
CREATE TABLE "PlaidItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "institutionId" TEXT,
    "institutionName" TEXT,
    "bankId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "errorCode" TEXT,
    "consentExpiration" TIMESTAMP(3),
    "nextCursor" TEXT,
    "lastSync" TIMESTAMP(3),
    "environment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaidItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaidTransaction" (
    "id" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "plaidTransactionId" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "date" DATE NOT NULL,
    "authorizedDate" DATE,
    "name" TEXT NOT NULL,
    "merchantName" TEXT,
    "paymentChannel" TEXT,
    "isoCurrencyCode" TEXT,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "category" JSONB,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processingError" TEXT,
    "matchedTransactionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaidTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlaidItem_itemId_key" ON "PlaidItem"("itemId");

-- CreateIndex
CREATE INDEX "PlaidItem_tenantId_idx" ON "PlaidItem"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaidTransaction_plaidTransactionId_key" ON "PlaidTransaction"("plaidTransactionId");

-- CreateIndex
CREATE INDEX "PlaidTransaction_plaidItemId_idx" ON "PlaidTransaction"("plaidItemId");

-- CreateIndex
CREATE INDEX "PlaidTransaction_processed_idx" ON "PlaidTransaction"("processed");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaidItem" ADD CONSTRAINT "PlaidItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaidItem" ADD CONSTRAINT "PlaidItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaidItem" ADD CONSTRAINT "PlaidItem_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaidTransaction" ADD CONSTRAINT "PlaidTransaction_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
