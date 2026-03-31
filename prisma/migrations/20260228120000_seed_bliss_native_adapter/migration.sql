-- Seed the Bliss Native CSV system adapter (global, tenantId = NULL)
-- This adapter bypasses AI classification; accounts and categories are resolved
-- per-row from the CSV itself using name or numeric ID.
-- The matchSignature.isNative flag tells the smart import worker to use native mode.
-- Idempotent: ON CONFLICT (id) DO NOTHING — safe to re-run.

INSERT INTO "ImportAdapter" (
  name,
  "matchSignature",
  "columnMapping",
  "amountStrategy",
  "currencyDefault",
  "skipRows",
  "tenantId",
  "isActive",
  "createdAt",
  "updatedAt"
)
VALUES (
  'Bliss Native CSV',
  '{"headers":["transactiondate","description","debit","credit"],"isNative":true}',
  '{"date":"transactiondate","description":"description","debit":"debit","credit":"credit","account":"account","category":"category","currency":"currency","details":"details","ticker":"ticker","assetQuantity":"assetquantity","assetPrice":"assetprice"}',
  'DEBIT_CREDIT_COLUMNS',
  'USD',
  0,
  NULL,
  true,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;
