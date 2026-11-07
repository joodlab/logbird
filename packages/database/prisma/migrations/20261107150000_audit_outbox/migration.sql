-- Additive only: no changes to existing data, keys, constraints or defaults.
CREATE TABLE "AuditOutbox" (
 "id" TEXT PRIMARY KEY, "stream" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "deliveredAt" TIMESTAMP(3), "lastError" TEXT
);
CREATE INDEX "AuditOutbox_deliveredAt_nextAttemptAt_idx" ON "AuditOutbox"("deliveredAt", "nextAttemptAt");
CREATE TABLE "AuthAuditWindow" (
 "id" TEXT PRIMARY KEY, "identity" TEXT NOT NULL, "reason" TEXT NOT NULL, "context" JSONB NOT NULL,
 "attempts" INTEGER NOT NULL DEFAULT 1, "flushedAttempts" INTEGER NOT NULL DEFAULT 0,
 "windowEnd" TIMESTAMP(3) NOT NULL, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AuthAuditWindow_nextAttemptAt_idx" ON "AuthAuditWindow"("nextAttemptAt");
CREATE TABLE "AuthAuditBudget" (
 "id" TEXT PRIMARY KEY, "stream" TEXT, "windowEnd" TIMESTAMP(3) NOT NULL,
 "admitted" INTEGER NOT NULL DEFAULT 0, "suppressed" INTEGER NOT NULL DEFAULT 0, "reported" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "AuthAuditBudget_reported_windowEnd_idx" ON "AuthAuditBudget"("reported", "windowEnd");
