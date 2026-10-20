-- eToro copy trading (#143). Hand-written: apply with `prisma migrate deploy`,
-- never `migrate dev` (see CLAUDE.md, pgvector rule).
--
-- Purely additive and idempotent: three tenant-scoped tables (connections,
-- copies, daily copy values) and the "Copy Trading" default category for
-- every existing tenant. See docs/specs/backend/25-etoro-copy-trading.md.

-- One eToro login per row, connected by a tenant admin with a Read key pair.
CREATE TABLE IF NOT EXISTS "EtoroConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "accountId" INTEGER,                  -- the Bliss account this login maps to
    "etoroCid" TEXT NOT NULL,             -- eToro customer id (stable identity)
    "etoroUsername" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,               -- encrypted (Prisma extension)
    "userKey" TEXT NOT NULL,              -- encrypted (Prisma extension)
    "keyLast4" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "errorCode" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EtoroConnection_pkey" PRIMARY KEY ("id")
);

-- One row per copy ("mirror") of a connection.
CREATE TABLE IF NOT EXISTS "EtoroCopy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "mirrorId" TEXT NOT NULL,
    "parentUsername" TEXT NOT NULL,       -- copied investor, lower-cased
    "parentCid" TEXT,
    "startedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "closedAt" TIMESTAMP(3),
    "lastValue" DECIMAL(18,8),
    "lastValueCurrency" TEXT NOT NULL DEFAULT 'USD',
    "lastValueAt" TIMESTAMP(3),
    "holdings" JSONB,
    "cashPct" DECIMAL(9,6),
    "unmappedPct" DECIMAL(9,6),
    "holdingsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EtoroCopy_pkey" PRIMARY KEY ("id")
);

-- eToro's value of a copy, one row per UTC day from the connection date on.
CREATE TABLE IF NOT EXISTS "EtoroCopyValue" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "copyId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "value" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "EtoroCopyValue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EtoroConnection_tenantId_idx" ON "EtoroConnection"("tenantId");
CREATE INDEX IF NOT EXISTS "EtoroConnection_status_idx" ON "EtoroConnection"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "EtoroConnection_tenantId_etoroCid_key" ON "EtoroConnection"("tenantId", "etoroCid");
CREATE INDEX IF NOT EXISTS "EtoroCopy_tenantId_parentUsername_idx" ON "EtoroCopy"("tenantId", "parentUsername");
CREATE UNIQUE INDEX IF NOT EXISTS "EtoroCopy_connectionId_mirrorId_key" ON "EtoroCopy"("connectionId", "mirrorId");
CREATE INDEX IF NOT EXISTS "EtoroCopyValue_tenantId_idx" ON "EtoroCopyValue"("tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "EtoroCopyValue_copyId_day_key" ON "EtoroCopyValue"("copyId", "day");

DO $$ BEGIN
    ALTER TABLE "EtoroConnection" ADD CONSTRAINT "EtoroConnection_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EtoroConnection" ADD CONSTRAINT "EtoroConnection_createdByUserId_fkey"
        FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EtoroConnection" ADD CONSTRAINT "EtoroConnection_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EtoroCopy" ADD CONSTRAINT "EtoroCopy_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EtoroCopy" ADD CONSTRAINT "EtoroCopy_connectionId_fkey"
        FOREIGN KEY ("connectionId") REFERENCES "EtoroConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EtoroCopyValue" ADD CONSTRAINT "EtoroCopyValue_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "EtoroCopyValue" ADD CONSTRAINT "EtoroCopyValue_copyId_fkey"
        FOREIGN KEY ("copyId") REFERENCES "EtoroCopy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- "Copy Trading" default category (R6) for every existing tenant. New tenants
-- get it from DEFAULT_CATEGORIES. A tenant that already has a category of that
-- name (or code) keeps its own and is skipped.
INSERT INTO "Category" ("name", "group", "type", "tenantId", "icon", "processingHint",
                        "portfolioItemKeyStrategy", "defaultCategoryCode", "createdAt", "updatedAt")
SELECT 'Copy Trading', 'Funds', 'Investments', t."id", '🔁', 'COPY_TRADING',
       'TICKER', 'COPY_TRADING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE NOT EXISTS (
    SELECT 1 FROM "Category" c
    WHERE c."tenantId" = t."id" AND c."defaultCategoryCode" = 'COPY_TRADING'
)
ON CONFLICT ("name", "tenantId") DO NOTHING;
