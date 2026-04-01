-- CreateTable
CREATE TABLE "DescriptionMapping" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "descriptionHash" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DescriptionMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DescriptionMapping_tenantId_idx" ON "DescriptionMapping"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DescriptionMapping_tenantId_descriptionHash_key" ON "DescriptionMapping"("tenantId", "descriptionHash");

-- AddForeignKey
ALTER TABLE "DescriptionMapping" ADD CONSTRAINT "DescriptionMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DescriptionMapping" ADD CONSTRAINT "DescriptionMapping_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
