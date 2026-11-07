-- Keep in-process tests and separately configured workers isolated in the same database.
ALTER TABLE "AuditOutbox" ADD COLUMN "namespace" TEXT NOT NULL DEFAULT '{logbird}';
ALTER TABLE "AuthAuditWindow" ADD COLUMN "namespace" TEXT NOT NULL DEFAULT '{logbird}';
ALTER TABLE "AuthAuditBudget" ADD COLUMN "namespace" TEXT NOT NULL DEFAULT '{logbird}';
