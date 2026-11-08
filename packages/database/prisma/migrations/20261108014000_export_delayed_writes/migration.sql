ALTER TABLE "ExportLease" ADD COLUMN "receivedBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ExportLease" ADD COLUMN "invalidated" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "ExportLease_projectId_expiresAt_idx" ON "ExportLease"("projectId", "expiresAt");
