-- CreateTable
CREATE TABLE "SecurityMaster" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "sector" TEXT,
    "industry" TEXT,
    "country" TEXT,
    "exchange" TEXT,
    "currency" TEXT,
    "isin" TEXT,
    "description" TEXT,
    "logoUrl" TEXT,
    "assetType" TEXT,
    "ceo" TEXT,
    "employees" INTEGER,
    "website" TEXT,
    "trailingEps" DECIMAL(12,4),
    "peRatio" DECIMAL(12,4),
    "annualizedDividend" DECIMAL(12,4),
    "dividendYield" DECIMAL(8,6),
    "latestEpsActual" DECIMAL(12,4),
    "latestEpsSurprise" DECIMAL(8,4),
    "week52High" DECIMAL(18,4),
    "week52Low" DECIMAL(18,4),
    "averageVolume" DECIMAL(18,0),
    "lastProfileUpdate" TIMESTAMP(3),
    "lastFundamentalsUpdate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityMaster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecurityMaster_symbol_key" ON "SecurityMaster"("symbol");

-- CreateIndex
CREATE INDEX "SecurityMaster_sector_idx" ON "SecurityMaster"("sector");

-- CreateIndex
CREATE INDEX "SecurityMaster_industry_idx" ON "SecurityMaster"("industry");

-- CreateIndex
CREATE INDEX "SecurityMaster_country_idx" ON "SecurityMaster"("country");

-- CreateIndex
CREATE INDEX "SecurityMaster_assetType_idx" ON "SecurityMaster"("assetType");
