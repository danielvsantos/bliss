-- Invite-only sign-up allowlist (#99). Hand-written: apply with
-- `prisma migrate deploy`, never `migrate dev` (see CLAUDE.md, pgvector rule).
--
-- Global table (no tenantId): an invite exists before its tenant does.
-- "email" holds deterministic ciphertext (same scheme as "User"."email").

-- CreateTable
CREATE TABLE IF NOT EXISTS "SignupInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "usedByTenantId" TEXT,

    CONSTRAINT "SignupInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SignupInvite_email_key" ON "SignupInvite"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SignupInvite_usedAt_idx" ON "SignupInvite"("usedAt");

-- AddForeignKey
ALTER TABLE "SignupInvite" ADD CONSTRAINT "SignupInvite_usedByTenantId_fkey" FOREIGN KEY ("usedByTenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
