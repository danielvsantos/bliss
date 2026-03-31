-- AlterTable
ALTER TABLE "Country" ADD COLUMN "iso2" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Country_iso2_key" ON "Country"("iso2");