-- Enable Banking (PSD2 AIS) bank sync (#132). Hand-written: apply with
-- `prisma migrate deploy`, never `migrate dev` (see CLAUDE.md, pgvector rule).
--
-- Purely additive and idempotent. Enable Banking connections reuse the
-- PlaidItem / PlaidTransaction / PlaidSyncLog pipeline (decision D1); this adds
-- the provider discriminator and one side table for per-account consent data.

-- PlaidItem: provider discriminator + the ASPSP country of an Enable Banking connection.
ALTER TABLE "PlaidItem" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'PLAID';
ALTER TABLE "PlaidItem" ADD COLUMN IF NOT EXISTS "aspspCountry" TEXT;
CREATE INDEX IF NOT EXISTS "PlaidItem_provider_status_idx" ON "PlaidItem"("provider", "status");

-- One row per bank account returned by POST /sessions.
CREATE TABLE IF NOT EXISTS "EnableBankingAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "authorizedByUserId" TEXT NOT NULL,
    "uid" TEXT NOT NULL,                  -- session-scoped, refreshed on reconnect
    "identificationHash" TEXT NOT NULL,   -- stable across sessions
    "iban" TEXT,                          -- encrypted (Prisma extension)
    "ibanLast4" TEXT,                     -- plaintext, for matching / display
    "currency" TEXT,
    "name" TEXT,
    "accountId" INTEGER,                  -- mapped Bliss account
    "lastBalance" DECIMAL(18,8),
    "lastBalanceCurrency" TEXT,
    "lastBalanceAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnableBankingAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EnableBankingAccount_plaidItemId_identificationHash_key"
    ON "EnableBankingAccount"("plaidItemId", "identificationHash");

-- R6 joint-account guard, enforced in the database: one bank account can be
-- mapped through only one connection per tenant. Partial index — Prisma cannot
-- model it, so it lives here only (see the comment on the model).
CREATE UNIQUE INDEX IF NOT EXISTS "EnableBankingAccount_mapped_hash_uniq"
    ON "EnableBankingAccount"("tenantId", "identificationHash") WHERE "accountId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "EnableBankingAccount_tenantId_idx" ON "EnableBankingAccount"("tenantId");
CREATE INDEX IF NOT EXISTS "EnableBankingAccount_accountId_idx" ON "EnableBankingAccount"("accountId");

DO $$ BEGIN
    ALTER TABLE "EnableBankingAccount" ADD CONSTRAINT "EnableBankingAccount_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EnableBankingAccount" ADD CONSTRAINT "EnableBankingAccount_plaidItemId_fkey"
        FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EnableBankingAccount" ADD CONSTRAINT "EnableBankingAccount_authorizedByUserId_fkey"
        FOREIGN KEY ("authorizedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EnableBankingAccount" ADD CONSTRAINT "EnableBankingAccount_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
