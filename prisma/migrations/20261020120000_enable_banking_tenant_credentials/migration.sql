-- Per-tenant Enable Banking credentials (#148). Hand-written: apply with
-- `prisma migrate deploy`, never `migrate dev` (see CLAUDE.md, pgvector rule).
--
-- Purely additive and idempotent. No backfill: the deployment-level
-- ENABLE_BANKING_APP_ID / _PRIVATE_KEY are retired and each tenant admin
-- enters their own app in Settings → Bank sync.

CREATE TABLE IF NOT EXISTS "EnableBankingCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,                -- encrypted (Prisma extension)
    "appIdHash" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,           -- encrypted (Prisma extension), write-only
    "keyFingerprint" TEXT NOT NULL,
    "keyBits" INTEGER NOT NULL,
    "status" TEXT NOT NULL,               -- VERIFIED | UNVERIFIED | INVALID
    "lastValidatedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "callbackRegistered" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnableBankingCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EnableBankingCredential_tenantId_key"
    ON "EnableBankingCredential"("tenantId");

CREATE TABLE IF NOT EXISTS "EnableBankingCredentialEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,               -- SET | REPLACED | KEY_ROTATED | REMOVED
    "appId" TEXT NOT NULL,                -- encrypted (Prisma extension)
    "appIdHash" TEXT NOT NULL,
    "keyFingerprint" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnableBankingCredentialEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EnableBankingCredentialEvent_tenantId_createdAt_idx"
    ON "EnableBankingCredentialEvent"("tenantId", "createdAt");

DO $$ BEGIN
    ALTER TABLE "EnableBankingCredential" ADD CONSTRAINT "EnableBankingCredential_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EnableBankingCredential" ADD CONSTRAINT "EnableBankingCredential_updatedByUserId_fkey"
        FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EnableBankingCredentialEvent" ADD CONSTRAINT "EnableBankingCredentialEvent_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EnableBankingCredentialEvent" ADD CONSTRAINT "EnableBankingCredentialEvent_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
