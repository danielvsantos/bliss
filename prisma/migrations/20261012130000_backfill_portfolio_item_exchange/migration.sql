-- #134: holdings created from the app form or MCP never received the listing
-- (exchange / ISIN / asset currency) of their transactions, so a ticker that
-- trades on several exchanges (NVD: Nvidia on Xetra, a 2x short ETF on Nasdaq)
-- was priced with Twelve Data's default listing. Data-only and idempotent:
-- re-running it changes nothing.

-- 1. Backfill each ticker-keyed holding without an exchange from its newest
--    linked transaction that carries one.
WITH "latest" AS (
  SELECT DISTINCT ON (t."portfolioItemId")
         t."portfolioItemId" AS "itemId", t."exchange", t."isin", t."assetCurrency"
  FROM "Transaction" t
  JOIN "PortfolioItem" pi ON pi."id" = t."portfolioItemId"
  WHERE pi."exchange" IS NULL
    AND t."exchange" IS NOT NULL
    AND t."exchange" <> ''
    AND t."ticker" = pi."symbol"
  ORDER BY t."portfolioItemId", t."transaction_date" DESC, t."id" DESC
)
UPDATE "PortfolioItem" pi
SET "exchange" = "latest"."exchange",
    "isin" = COALESCE(pi."isin", "latest"."isin"),
    "assetCurrency" = COALESCE(pi."assetCurrency", "latest"."assetCurrency")
FROM "latest"
WHERE pi."id" = "latest"."itemId";

-- 2. Remove bare-symbol (exchange = '') stock/fund prices that no holding uses
--    any more: every holding of that symbol now has an exchange. Prices are
--    shared across tenants, so rows still used by a holding without an
--    exchange are kept.
DELETE FROM "AssetPrice" ap
WHERE ap."exchange" = ''
  AND ap."assetType" IN ('API_STOCK', 'API_FUND')
  AND EXISTS (
    SELECT 1 FROM "PortfolioItem" pi
    WHERE pi."symbol" = ap."symbol" AND pi."exchange" IS NOT NULL AND pi."exchange" <> ''
  )
  AND NOT EXISTS (
    SELECT 1 FROM "PortfolioItem" pi
    WHERE pi."symbol" = ap."symbol" AND (pi."exchange" IS NULL OR pi."exchange" = '')
  );
