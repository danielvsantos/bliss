-- Longer-lived sessions (#156): refresh-token families + immediate revocation.
-- Hand-written: apply with `prisma migrate deploy`, never `migrate dev`
-- (see CLAUDE.md — the pgvector embedding columns are not in schema.prisma).
-- Purely additive. Touches no pgvector state.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionsRevokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UserSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "previousTokenHash" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "authenticatedAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserSession_tenantId_userId_idx" ON "UserSession"("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "UserSession_absoluteExpiresAt_idx" ON "UserSession"("absoluteExpiresAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
