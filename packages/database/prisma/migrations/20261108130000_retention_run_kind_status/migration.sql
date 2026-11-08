-- Additive and backwards compatible: failed-repair checks, read fences and readiness filter by project, kind
-- and status. The existing (projectId, startedAt) index stays for latest-run lookups.
CREATE INDEX IF NOT EXISTS "RetentionRun_projectId_kind_status_idx" ON "RetentionRun"("projectId", "kind", "status");
