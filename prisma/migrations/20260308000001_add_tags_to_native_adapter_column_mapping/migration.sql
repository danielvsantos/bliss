-- Add "tags" to the Bliss Native CSV adapter's columnMapping.
-- matchSignature.headers is NOT changed — "tags" is an optional CSV column.
-- CSVs without a tags column still match the adapter; getColumnValue() returns null.
UPDATE "ImportAdapter"
SET "columnMapping" = "columnMapping"::jsonb || '{"tags":"tags"}'::jsonb,
    "updatedAt" = NOW()
WHERE ("matchSignature"::jsonb ->> 'isNative')::boolean = true;
