-- Use plain CREATE INDEX, NOT CONCURRENTLY, because Prisma may run the migration inside a transaction and RetentionRun is small.
CREATE INDEX IF NOT EXISTS "RetentionRun_failed_ingest_repair" ON "RetentionRun" ("projectId", "startedAt") WHERE kind = 'ingest_repair' AND status = 'failed';
