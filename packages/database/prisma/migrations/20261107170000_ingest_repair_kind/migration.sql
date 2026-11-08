ALTER TABLE "RetentionRun" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'retention';
ALTER TABLE "RetentionRun" ADD CONSTRAINT "RetentionRun_kind_check" CHECK ("kind" IN ('retention', 'ingest_repair'));
