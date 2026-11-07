-- Preserve ambiguous pre-deployment hook intents without claiming that deletion committed.
-- Retain deprecated columns for rolling application compatibility; owned endpoints never write them.
UPDATE "AuditOutbox" SET "quarantinedAt"=CURRENT_TIMESTAMP, "lastError"='legacy_session_intent'
WHERE id IN (SELECT id FROM "AuditOutbox" WHERE "sourceSessionId" IS NOT NULL
  AND "confirmedAt" IS NULL AND "quarantinedAt" IS NULL ORDER BY "createdAt" LIMIT 100 FOR UPDATE SKIP LOCKED);
COMMENT ON COLUMN "AuditOutbox"."sourceSessionId" IS 'Deprecated hook intent field; retained for rolling compatibility only';
COMMENT ON COLUMN "AuditOutbox"."confirmedAt" IS 'Deprecated intent gate; owned mutations insert directly confirmed rows';
CREATE INDEX "AuthAuditWindow_completed_legacy_idx" ON "AuthAuditWindow" (namespace, "nextAttemptAt", id)
WHERE "emailHash" IS NULL AND identity='' AND "closedAt" IS NULL AND "quarantinedAt" IS NULL;
