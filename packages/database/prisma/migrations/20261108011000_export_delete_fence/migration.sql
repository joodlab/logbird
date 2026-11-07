-- Persist the boundary before ClickHouse I/O; a failed/partial purge must still invalidate exports.
ALTER TABLE "Project" ADD COLUMN "exportDeleteStartedAt" TIMESTAMP(3);
