-- Reuse the existing nullable marker as a durable destructive-maintenance fence.
-- No data is cleared: an old marker needs the same query/mutation reconciliation.
CREATE INDEX IF NOT EXISTS "Project_exportDeleteStartedAt_id_idx" ON "Project"("exportDeleteStartedAt", "id");
