-- Seed preconfigured bank CSV adapters (global, tenantId = NULL).
-- These adapters enable auto-detection of CSV exports from major banks worldwide.
-- Idempotent: each INSERT uses WHERE NOT EXISTS to prevent duplicates on re-run.

-- ═══════════════════════════════════════════════════════════════════════════════
-- US Banks
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Chase (checking/savings)
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Chase CSV',
  '{"headers":["Details","Posting Date","Description","Amount","Type","Balance","Check or Slip #"]}',
  '{"date":"Posting Date","description":"Description","amount":"Amount"}',
  'MM/DD/YYYY', 'SINGLE_SIGNED', 'USD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Chase CSV' AND "tenantId" IS NULL);

-- 2. Bank of America
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Bank of America CSV',
  '{"headers":["Date","Description","Amount","Running Bal."]}',
  '{"date":"Date","description":"Description","amount":"Amount"}',
  'MM/DD/YYYY', 'SINGLE_SIGNED', 'USD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Bank of America CSV' AND "tenantId" IS NULL);

-- 3. Citi
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Citi CSV',
  '{"headers":["Status","Date","Description","Debit","Credit"]}',
  '{"date":"Date","description":"Description","debit":"Debit","credit":"Credit"}',
  'MM/DD/YYYY', 'DEBIT_CREDIT_COLUMNS', 'USD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Citi CSV' AND "tenantId" IS NULL);

-- 4. Capital One
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Capital One CSV',
  '{"headers":["Transaction Date","Posted Date","Card No.","Description","Category","Debit","Credit"]}',
  '{"date":"Transaction Date","description":"Description","debit":"Debit","credit":"Credit"}',
  'MM/DD/YYYY', 'DEBIT_CREDIT_COLUMNS', 'USD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Capital One CSV' AND "tenantId" IS NULL);

-- 5. American Express (inverted sign: positive = charge, negative = payment)
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'American Express CSV',
  '{"headers":["Date","Description","Amount"]}',
  '{"date":"Date","description":"Description","amount":"Amount"}',
  'MM/DD/YYYY', 'SINGLE_SIGNED_INVERTED', 'USD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'American Express CSV' AND "tenantId" IS NULL);

-- 6. Discover
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Discover CSV',
  '{"headers":["Trans. Date","Post Date","Description","Amount","Category"]}',
  '{"date":"Trans. Date","description":"Description","amount":"Amount"}',
  'MM/DD/YYYY', 'SINGLE_SIGNED', 'USD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Discover CSV' AND "tenantId" IS NULL);

-- 7. US Bank
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'US Bank CSV',
  '{"headers":["Date","Transaction","Name","Memo","Amount"]}',
  '{"date":"Date","description":["Transaction","Name"],"amount":"Amount","details":"Memo"}',
  'MM/DD/YYYY', 'SINGLE_SIGNED', 'USD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'US Bank CSV' AND "tenantId" IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- UK Banks
-- ═══════════════════════════════════════════════════════════════════════════════

-- 8. HSBC UK
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'HSBC UK CSV',
  '{"headers":["Date","Description","Money In","Money Out","Balance"]}',
  '{"date":"Date","description":"Description","credit":"Money In","debit":"Money Out"}',
  'DD/MM/YYYY', 'DEBIT_CREDIT_COLUMNS', 'GBP', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'HSBC UK CSV' AND "tenantId" IS NULL);

-- 9. Barclays UK
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Barclays UK CSV',
  '{"headers":["Number","Date","Account","Amount","Subcategory","Memo"]}',
  '{"date":"Date","description":"Memo","amount":"Amount"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'GBP', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Barclays UK CSV' AND "tenantId" IS NULL);

-- 10. Lloyds UK
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Lloyds UK CSV',
  '{"headers":["Transaction Date","Transaction Type","Sort Code","Account Number","Transaction Description","Debit Amount","Credit Amount","Balance"]}',
  '{"date":"Transaction Date","description":"Transaction Description","debit":"Debit Amount","credit":"Credit Amount"}',
  'DD/MM/YYYY', 'DEBIT_CREDIT_COLUMNS', 'GBP', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Lloyds UK CSV' AND "tenantId" IS NULL);

-- 11. Monzo
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Monzo CSV',
  '{"headers":["Date","Time","Type","Name","Emoji","Category","Amount","Currency","Local amount","Local currency","Notes and #tags"]}',
  '{"date":"Date","description":"Name","amount":"Amount","currency":"Currency","category":"Category"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'GBP', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Monzo CSV' AND "tenantId" IS NULL);

-- 12. Santander UK
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Santander UK CSV',
  '{"headers":["Date","Description","Amount","Balance"]}',
  '{"date":"Date","description":"Description","amount":"Amount"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'GBP', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Santander UK CSV' AND "tenantId" IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- EU Banks — Spain
-- ═══════════════════════════════════════════════════════════════════════════════

-- 13. BBVA Spain
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'BBVA Spain CSV',
  '{"headers":["Fecha","Concepto","Movimiento","Importe","Divisa","Disponible"]}',
  '{"date":"Fecha","description":"Concepto","amount":"Importe","currency":"Divisa"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'EUR', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'BBVA Spain CSV' AND "tenantId" IS NULL);

-- 14. CaixaBank
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'CaixaBank CSV',
  '{"headers":["Fecha","Fecha valor","Concepto","Movimiento","Importe"]}',
  '{"date":"Fecha","description":"Concepto","amount":"Importe"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'EUR', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'CaixaBank CSV' AND "tenantId" IS NULL);

-- 15. Santander Spain
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Santander Spain CSV',
  '{"headers":["Fecha","Concepto","Importe","Saldo"]}',
  '{"date":"Fecha","description":"Concepto","amount":"Importe"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'EUR', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Santander Spain CSV' AND "tenantId" IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- EU Banks — France
-- ═══════════════════════════════════════════════════════════════════════════════

-- 16. Boursorama
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Boursorama CSV',
  '{"headers":["dateOp","dateVal","label","category","categoryParent","supplierFound","amount","accountNum","accountLabel","accountBalance"]}',
  '{"date":"dateOp","description":"label","amount":"amount","category":"category"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'EUR', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Boursorama CSV' AND "tenantId" IS NULL);

-- 17. Credit Agricole
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Credit Agricole CSV',
  '{"headers":["Date","Libelle","Debit euros","Credit euros"]}',
  '{"date":"Date","description":"Libelle","debit":"Debit euros","credit":"Credit euros"}',
  'DD/MM/YYYY', 'DEBIT_CREDIT_COLUMNS', 'EUR', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Credit Agricole CSV' AND "tenantId" IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- EU Banks — Other
-- ═══════════════════════════════════════════════════════════════════════════════

-- 18. N26
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'N26 CSV',
  '{"headers":["Date","Payee","Account number","Transaction type","Payment reference","Amount (EUR)"]}',
  '{"date":"Date","description":"Payee","amount":"Amount (EUR)","details":"Payment reference"}',
  'YYYY-MM-DD', 'SINGLE_SIGNED', 'EUR', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'N26 CSV' AND "tenantId" IS NULL);

-- 19. Wise (TransferWise)
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Wise CSV',
  '{"headers":["TransferWise ID","Date","Amount","Currency","Description","Payment Reference","Running Balance"]}',
  '{"date":"Date","description":"Description","amount":"Amount","currency":"Currency","details":"Payment Reference"}',
  'YYYY-MM-DD', 'SINGLE_SIGNED', NULL, 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Wise CSV' AND "tenantId" IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Brazil
-- ═══════════════════════════════════════════════════════════════════════════════

-- 20. Itau
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Itau CSV',
  '{"headers":["data","lancamento","ag./origem","valor (R$)"]}',
  '{"date":"data","description":"lancamento","amount":"valor (R$)"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'BRL', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Itau CSV' AND "tenantId" IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Canada
-- ═══════════════════════════════════════════════════════════════════════════════

-- 21. RBC Canada
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'RBC Canada CSV',
  '{"headers":["Account Type","Account Number","Transaction Date","Cheque Number","Description 1","Description 2","CAD$","USD$"]}',
  '{"date":"Transaction Date","description":["Description 1","Description 2"],"amount":"CAD$"}',
  'MM/DD/YYYY', 'SINGLE_SIGNED', 'CAD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'RBC Canada CSV' AND "tenantId" IS NULL);

-- 22. TD Canada
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'TD Canada CSV',
  '{"headers":["Date","Description","Withdrawals","Deposits","Balance"]}',
  '{"date":"Date","description":"Description","debit":"Withdrawals","credit":"Deposits"}',
  'MM/DD/YYYY', 'DEBIT_CREDIT_COLUMNS', 'CAD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'TD Canada CSV' AND "tenantId" IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Australia
-- ═══════════════════════════════════════════════════════════════════════════════

-- 23. ANZ Australia
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'ANZ Australia CSV',
  '{"headers":["Date","Amount","Description"]}',
  '{"date":"Date","description":"Description","amount":"Amount"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'AUD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'ANZ Australia CSV' AND "tenantId" IS NULL);

-- 24. Commonwealth Bank Australia
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Commonwealth Bank Australia CSV',
  '{"headers":["Date","Amount","Description","Balance"]}',
  '{"date":"Date","description":"Description","amount":"Amount"}',
  'DD/MM/YYYY', 'SINGLE_SIGNED', 'AUD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Commonwealth Bank Australia CSV' AND "tenantId" IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Brokerage
-- ═══════════════════════════════════════════════════════════════════════════════

-- 25. Interactive Brokers (trade confirmations)
INSERT INTO "ImportAdapter" (name, "matchSignature", "columnMapping", "dateFormat", "amountStrategy", "currencyDefault", "skipRows", "tenantId", "isActive", "createdAt", "updatedAt")
SELECT 'Interactive Brokers Trades CSV',
  '{"headers":["Currency","Symbol","Date/Time","Quantity","T. Price","Proceeds","Comm/Fee","Realized P/L"]}',
  '{"date":"Date/Time","description":"Symbol","amount":"Realized P/L","ticker":"Symbol","assetQuantity":"Quantity","assetPrice":"T. Price","currency":"Currency"}',
  'YYYY-MM-DD', 'SINGLE_SIGNED', 'USD', 0, NULL, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "ImportAdapter" WHERE name = 'Interactive Brokers Trades CSV' AND "tenantId" IS NULL);
