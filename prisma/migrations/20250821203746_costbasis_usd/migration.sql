-- AlterTable
ALTER TABLE "PortfolioItem" ADD COLUMN     "costBasisInUSD" DECIMAL(18,8),
ADD COLUMN     "currentValueInUSD" DECIMAL(18,8),
ADD COLUMN     "realizedPnLInUSD" DECIMAL(18,8),
ADD COLUMN     "totalInvestedInUSD" DECIMAL(18,8);
