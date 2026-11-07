-- Additive, compatible with already deployed round-2 clients. No business rows are rewritten.
ALTER TABLE "user" ADD COLUMN "emailHash" TEXT;
CREATE INDEX "user_emailHash_idx" ON "user"("emailHash");
ALTER TABLE "AuditOutbox"
  ADD COLUMN "confirmedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "sourceSessionId" TEXT,
  ADD COLUMN "quarantinedAt" TIMESTAMP(3);
CREATE INDEX "AuditOutbox_namespace_confirmedAt_createdAt_idx" ON "AuditOutbox"("namespace", "confirmedAt", "createdAt");
CREATE INDEX "AuditOutbox_namespace_deliveredAt_idx" ON "AuditOutbox"("namespace", "deliveredAt");
ALTER TABLE "AuthAuditWindow"
  ALTER COLUMN "identity" SET DEFAULT '',
  ADD COLUMN "emailHash" TEXT,
  ADD COLUMN "firstAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastContext" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "distinctIps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ipsTruncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "prepareAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "quarantinedAt" TIMESTAMP(3),
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "overflow" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "AuthAuditWindow_namespace_closedAt_windowEnd_idx" ON "AuthAuditWindow"("namespace", "closedAt", "windowEnd");
ALTER TABLE "AuthAuditBudget" ADD COLUMN "targets" JSONB NOT NULL DEFAULT '{}';
