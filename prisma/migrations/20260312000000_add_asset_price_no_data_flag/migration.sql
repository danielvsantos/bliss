-- Add noData flag to AssetPrice to cache known TwelveData no-data dates (holidays, market closures).
-- When noData = true, the valuation worker skips the API call on subsequent runs,
-- preventing repeated failed requests for dates we already know have no data.

ALTER TABLE "AssetPrice" ADD COLUMN "noData" BOOLEAN NOT NULL DEFAULT false;
