-- Trust gates for earnings- and dividend-derived fields on SecurityMaster.
--
-- Twelve Data's /earnings and /dividends responses are inconsistent across
-- symbols (timezone skew, unsorted arrays, sparse histories, future-only
-- responses). Past versions of the refresh job silently produced wrong P/E
-- and trailing-EPS values for ~50 stocks at a time. Rather than fail the
-- refresh, the worker now records whether the computed fields can be
-- trusted; consumers (insights LLM, equity analysis API) hide them when
-- false. Default false so any row that has not yet been refreshed under
-- the new logic is treated as untrusted until proven otherwise.

ALTER TABLE "SecurityMaster"
  ADD COLUMN "earningsTrusted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dividendTrusted" BOOLEAN NOT NULL DEFAULT false;
