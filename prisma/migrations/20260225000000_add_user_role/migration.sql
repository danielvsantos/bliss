-- AddColumn: role field on User model
-- Default: "member" for all existing rows

ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'member';
