ALTER TABLE "AuditOutbox" ADD COLUMN "awaitingUntil" TIMESTAMP(3);
ALTER TABLE "AuditOutbox" ADD COLUMN "pendingOutcome" JSONB;
CREATE INDEX "AuditOutbox_namespace_awaitingUntil_idx" ON "AuditOutbox"("namespace", "awaitingUntil");

CREATE TABLE "ExportLease" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "namespace" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ExportLease_namespace_expiresAt_idx" ON "ExportLease"("namespace", "expiresAt");
CREATE INDEX "ExportLease_namespace_userId_expiresAt_idx" ON "ExportLease"("namespace", "userId", "expiresAt");
CREATE INDEX "ExportLease_namespace_workspaceId_expiresAt_idx" ON "ExportLease"("namespace", "workspaceId", "expiresAt");
